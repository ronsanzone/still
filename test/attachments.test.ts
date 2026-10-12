import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Stream,
} from "effect";
import sharp from "sharp";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { Chats } from "../src/server/chat.ts";
import { ModelCatalog } from "../src/server/models.ts";
import { Attachments, attachmentsLayer } from "../src/kernel/attachments.ts";
import {
  fenceAttachment,
  AttachmentUpload,
} from "../src/shared/attachments.ts";

// A real one-page PDF fixture, generated with byte-accurate xref offsets.
function pdfFixture(): Buffer {
  const stream = "BT /F1 12 Tf 20 100 Td (Full PDF attachment text) Tj ET\n";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf);
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "still-attachments-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const upload = (
  bytes: Buffer,
  mimeType: AttachmentUpload["mimeType"],
  name = "file",
) => ({ name, mimeType, data: bytes.toString("base64") });

const admit = (input: { name: string; mimeType: string; data: string }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decoded =
        yield* Schema.decodeUnknownEffect(AttachmentUpload)(input);

      return yield* (yield* Attachments).admit(decoded);
    }).pipe(Effect.provide(attachmentsLayer(directory))),
  );

const readPdf = (hash: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Attachments).readPdf(hash);
    }).pipe(Effect.provide(attachmentsLayer(directory))),
  );

it("admits native image/PDF context once, preserves it in edit branches and after restart, and scopes downloads", async () => {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: UserMessage[] = [];
  faux.setResponses(
    Array.from({ length: 3 }, () => (input) => {
      requests.push(
        ...input.messages.filter((message) => message.role === "user"),
      );

      return fauxAssistantMessage("The PDF says Full PDF attachment text [2].");
    }),
  );

  const layer = Chats.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ModelCatalog,
        ModelCatalog.of({
          runtime: models,
          choices: [{ id: "faux/faux-1", name: "Faux", provider: "faux" }],
        }),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          STILL_DATABASE: join(directory, "chat.sqlite"),
        }),
      ),
    ),
  );

  let runtime = ManagedRuntime.make(layer);

  const wait = (id: number) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const chats = yield* Chats;

        return yield* chats.watch(id).pipe(
          Stream.filter(
            (value) =>
              !value.busy &&
              value.messages.some((message) => message.role === "assistant"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
      }),
    );

  try {
    const image = await sharp({
      create: { width: 12, height: 6, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();

    const pdf = pdfFixture();

    const input = {
      text: "Explain these attachments",
      requestId: "attachment-input",
      attachments: [
        upload(image, "image/png", "photo.png"),
        upload(pdf, "application/pdf", "notes.pdf"),
      ],
    };

    const chat = await runtime.runPromise(
      Effect.flatMap(Chats, (chats) => chats.create("faux/faux-1")),
    );

    const receipt = await runtime.runPromise(
      Effect.flatMap(Chats, (chats) => chats.send(chat.id, input)),
    );

    const done = await wait(chat.id);
    expect(done.attachments.map((item) => item.name)).toEqual([
      "photo.png",
      "notes.pdf",
    ]);
    expect(done.citations.map((item) => item.number)).toEqual([1, 2]);
    expect(done.messages[0]?.images).toHaveLength(1);
    expect(done.messages[0]?.attachmentText).toContain(
      "Full PDF attachment text",
    );
    const hash = createHash("sha256").update(pdf).digest("hex");
    expect(
      Buffer.from(
        await runtime.runPromise(
          Effect.flatMap(Chats, (chats) => chats.pdf(chat.id, hash)),
        ),
      ),
    ).toEqual(pdf);

    const other = await runtime.runPromise(
      Effect.flatMap(Chats, (chats) => chats.create("faux/faux-1")),
    );

    await expect(
      runtime.runPromise(
        Effect.flatMap(Chats, (chats) => chats.pdf(other.id, hash)),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const original = done.messages[0];

    if (!original?.before || !original.entry)
      throw new Error("No branch boundary");

    const child = await runtime.runPromise(
      Effect.flatMap(Chats, (chats) =>
        chats.branch(chat.id, {
          entry: original.before ?? 0,
          model: "faux/faux-1",
        }),
      ),
    );

    await runtime.runPromise(
      Effect.flatMap(Chats, (chats) =>
        chats.send(child.id, {
          text: "Edited attachment question",
          requestId: "attachment-edited",
          reuseEntry: original.entry,
        }),
      ),
    );
    const branch = await wait(child.id);
    expect(branch.grant.kit).toBe("chat");
    expect(branch.messages[0]?.images).toEqual(original.images);
    expect(branch.messages[0]?.attachmentText).toEqual(original.attachmentText);
    expect(requests.at(-1)?.content).toEqual([
      { type: "text", text: "Edited attachment question" },
      ...(Array.isArray(requests[0]?.content)
        ? requests[0].content.slice(1)
        : []),
    ]);
    await runtime.dispose();
    runtime = ManagedRuntime.make(layer);
    expect((await wait(chat.id)).citations).toEqual(done.citations);
    expect(
      await runtime.runPromise(
        Effect.flatMap(Chats, (chats) => chats.send(chat.id, input)),
      ),
    ).toEqual(receipt);
    expect(faux.state.callCount).toBe(2);
  } finally {
    await runtime.dispose();
  }
});

it("decodes and downscales real images into native provider content", async () => {
  const bytes = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();

  const result = await admit(upload(bytes, "image/jpeg", "photo.jpg"));

  const message: UserMessage = {
    role: "user",
    content: [...result.content],
    timestamp: 0,
  };

  expect(message.content).toEqual(result.content);
  const image = result.content.find((part) => part.type === "image");
  expect(image?.mimeType).toBe("image/png");

  if (!image) throw new Error("Missing native image");
  const info = await sharp(Buffer.from(image.data, "base64")).metadata();
  expect([info.width, info.height]).toEqual([1600, 800]);
  expect(result.metadata.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  await expect(admit(upload(bytes, "image/png"))).rejects.toThrow();
});

it("extracts a real PDF and stores only its content-addressed original", async () => {
  const bytes = pdfFixture();

  const copies = await Promise.all(
    Array.from({ length: 4 }, () =>
      admit(upload(bytes, "application/pdf", "../../escape.pdf")),
    ),
  );

  const result = copies[0];

  if (!result) throw new Error("No PDF admitted");
  expect(new Set(copies.map((copy) => copy.metadata.sha256)).size).toBe(1);

  expect(result.metadata.name).toBe("escape.pdf");
  expect(result.content).toContainEqual(
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining("Full PDF attachment text"),
    }),
  );
  expect(
    await readFile(join(directory, `${result.metadata.sha256}.pdf`)),
  ).toEqual(bytes);
  expect(Buffer.from(await readPdf(result.metadata.sha256))).toEqual(bytes);
  expect((await admit(upload(bytes, "application/pdf"))).metadata.sha256).toBe(
    result.metadata.sha256,
  );
  await expect(readPdf("../../escape.pdf")).rejects.toThrow();
  await writeFile(
    join(directory, `${result.metadata.sha256}.pdf`),
    "corrupted",
  );
  await expect(readPdf(result.metadata.sha256)).rejects.toThrow();
  await expect(admit(upload(bytes, "application/pdf"))).rejects.toThrow();
});

it("does not follow a stored-object symlink", async () => {
  const bytes = pdfFixture();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const target = join(directory, "original");
  await writeFile(target, bytes);
  await symlink(target, join(directory, `${hash}.pdf`));
  await expect(readPdf(hash)).rejects.toThrow();
  await expect(admit(upload(bytes, "application/pdf"))).rejects.toThrow();
});

it("retains malicious names as inert native metadata and uses unforgeable fences", async () => {
  const text = "hello\n```\nforged\n``````\n<script>alert(1)</script>";
  const name = "../\\attack\u0000\n``````.txt";
  const result = await admit(upload(Buffer.from(text), "text/plain", name));
  expect(result.metadata.name).not.toMatch(/[\\/\u0000\n]/);
  expect(result.content[0]).toEqual({
    type: "text",
    text: expect.stringContaining(JSON.stringify(name)),
  });
  const fenced = fenceAttachment(text);
  expect(fenced).toContain("```````untrusted-attachment");
  expect(fenced).not.toContain("<script>");
  expect(
    fenceAttachment("</untrusted>injection").match(/<\/untrusted>/g),
  ).toHaveLength(1);
  expect(result.content[1]).toEqual({ type: "text", text: fenced });
});

it("accepts empty UTF-8 text without arbitrary size limits", async () => {
  const result = await admit(upload(Buffer.alloc(0), "text/plain"));
  expect(result.metadata.bytes).toBe(0);
  expect(result.content[1]).toEqual({
    type: "text",
    text: fenceAttachment(""),
  });
});

it.each([
  { name: "bad", mimeType: "image/png", data: "not base64!" },
  { name: "bad", mimeType: "text/plain", data: "Zh==" },
  upload(Buffer.from("not an image"), "image/png"),
  upload(Buffer.from("%PDF-1.4\ninvalid"), "application/pdf"),
  upload(pdfFixture(), "text/plain"),
  upload(Buffer.from([0xff, 0xfe]), "text/plain"),
  upload(Buffer.from([0, 1, 2]), "text/plain"),
  { name: "bad", mimeType: "application/octet-stream", data: "AAAA" },
])(
  "rejects invalid bytes, noncanonical base64 and MIME spoofing: $mimeType",
  async (input) => {
    await expect(admit(input)).rejects.toThrow();
  },
);
