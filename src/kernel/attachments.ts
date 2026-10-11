import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { defineEntry } from "@earendil-works/pi-durable";
import type { Citation } from "../shared/research.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  AttachmentMetadata,
  AttachmentUpload,
  fenceAttachment,
} from "../shared/attachments.ts";

export const AttachmentEntry = defineEntry<{
  files: AttachmentMetadata[];
  citations: Citation[];
}>("still.attachments");

export class AttachmentFailure extends Schema.TaggedError<AttachmentFailure>()(
  "AttachmentFailure",
  {
    message: Schema.String,
  },
) {}

export interface AdmittedAttachment {
  readonly metadata: AttachmentMetadata;
  readonly content: readonly (TextContent | ImageContent)[];
}

export class Attachments extends Context.Service<
  Attachments,
  {
    readonly admit: (
      input: AttachmentUpload,
    ) => Effect.Effect<AdmittedAttachment, AttachmentFailure>;
    readonly readPdf: (
      identity: string,
    ) => Effect.Effect<Uint8Array, AttachmentFailure>;
  }
>()("still/Attachments") {}

const failure = () =>
  new AttachmentFailure({ message: "Invalid or unreadable attachment" });

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export const attachmentsLayer = (directory: string) =>
  Layer.effect(
    Attachments,
    Effect.sync(() => {
      const root = resolve(directory);

      const readPdf = Effect.fn("Attachments.readPdf")(function* (
        identity: string,
      ) {
        const hash = yield* Schema.decodeUnknownEffect(
          AttachmentMetadata.fields.sha256,
        )(identity).pipe(Effect.mapError(failure));

        return yield* Effect.tryPromise({
          try: async () => {
            const handle = await open(
              resolve(root, `${hash}.pdf`),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );

            try {
              const bytes = await handle.readFile();

              if (digest(bytes) !== hash) throw new Error("Hash mismatch");

              return new Uint8Array(bytes);
            } finally {
              await handle.close();
            }
          },
          catch: failure,
        });
      });

      const admit = Effect.fn("Attachments.admit")(function* (
        input: AttachmentUpload,
      ) {
        const upload = yield* Schema.decodeUnknownEffect(AttachmentUpload)(
          input,
        ).pipe(Effect.mapError(failure));

        return yield* Effect.tryPromise({
          try: async (): Promise<AdmittedAttachment> => {
            const bytes = Buffer.from(upload.data, "base64");

            if (
              bytes.toString("base64") !== upload.data ||
              (bytes.length === 0 && upload.mimeType !== "text/plain")
            )
              throw new Error("Invalid base64");

            const metadata: AttachmentMetadata = {
              name:
                upload.name
                  .replaceAll("\\", "/")
                  .split("/")
                  .at(-1)
                  ?.replace(/[\u0000-\u001f\u007f]/g, "") || "attachment",
              mimeType: upload.mimeType,
              sha256: digest(bytes),
              bytes: bytes.length,
            };

            // Preserve the original display name inside the native transcript, without granting it path authority.
            const header: TextContent = {
              type: "text",
              text: fenceAttachment(
                `Attachment metadata: ${JSON.stringify({ ...metadata, originalName: upload.name })}`,
              ),
            };

            if (upload.mimeType.startsWith("image/")) {
              const image = sharp(bytes, {
                failOn: "warning",
                limitInputPixels: false,
              });

              const info = await image.metadata();

              if (
                `image/${info.format}` !== upload.mimeType ||
                (info.pages ?? 1) !== 1
              )
                throw new Error("Image MIME mismatch or animation");

              const normalized = await image
                .rotate()
                .resize({
                  width: 1600,
                  height: 1600,
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .png()
                .toBuffer();

              return {
                metadata,
                content: [
                  header,
                  {
                    type: "image",
                    mimeType: "image/png",
                    data: normalized.toString("base64"),
                  },
                ],
              };
            }

            let text: string;

            if (upload.mimeType === "application/pdf") {
              if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
                throw new Error("PDF MIME mismatch");

              const task = getDocument({
                data: new Uint8Array(bytes),
                useSystemFonts: false,
              });

              try {
                const document = await task.promise;
                const pages: string[] = [];

                for (
                  let pageNumber = 1;
                  pageNumber <= document.numPages;
                  pageNumber += 1
                ) {
                  const page = await document.getPage(pageNumber);
                  const extracted = await page.getTextContent();
                  pages.push(
                    extracted.items
                      .map((item) =>
                        "str" in item
                          ? item.str + (item.hasEOL ? "\n" : " ")
                          : "",
                      )
                      .join(""),
                  );
                  page.cleanup();
                }

                text = pages.join("\n\n");
              } finally {
                await task.destroy();
              }

              await mkdir(root, { recursive: true, mode: 0o700 });
              const path = resolve(root, `${metadata.sha256}.pdf`);
              const temporary = resolve(root, `.upload-${randomUUID()}`);

              try {
                const handle = await open(
                  temporary,
                  constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                  0o600,
                );

                try {
                  await handle.writeFile(bytes);
                  await handle.sync();
                } finally {
                  await handle.close();
                }

                // Publish complete bytes atomically without replacing an existing object.
                await link(temporary, path);
              } catch (error) {
                if (!(
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "EEXIST"
                ))
                  throw error;

                // Do not trust an existing object, including a symlink, just because its name matches.
                const stored = await open(
                  path,
                  constants.O_RDONLY | constants.O_NOFOLLOW,
                );

                try {
                  if (digest(await stored.readFile()) !== metadata.sha256)
                    throw new Error("Stored hash mismatch");
                } finally {
                  await stored.close();
                }
              } finally {
                try {
                  await unlink(temporary);
                } catch (error) {
                  if (!(
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ENOENT"
                  ))
                    throw error;
                }
              }
            } else {
              text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

              if (
                /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
                text.startsWith("%PDF-")
              )
                throw new Error("Not plain UTF-8 text");
            }

            return {
              metadata,
              content: [header, { type: "text", text: fenceAttachment(text) }],
            };
          },
          catch: failure,
        });
      });

      return Attachments.of({ admit, readPdf });
    }),
  );

export const attachmentsConfigLayer = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("STILL_DATABASE").pipe(
      Config.withDefault(".data/still-v1.sqlite"),
    );

    const directory = yield* Config.String("STILL_ATTACHMENTS_DIR").pipe(
      Config.withDefault(resolve(dirname(database), "attachments")),
    );

    return attachmentsLayer(directory);
  }),
);
