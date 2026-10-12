import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Stream } from "effect";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Chats } from "../src/server/chat.ts";
import { ModelCatalog } from "../src/server/models.ts";

const modelId = "faux/faux-1";

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(async () =>
    realpath(await mkdtemp(join(tmpdir(), "still-agent-test-"))),
  ),
  (directory) =>
    Effect.promise(() => rm(directory, { force: true, recursive: true })),
);

describe("Still agent", () => {
  it.effect(
    "gives every chat and branch shell tools in the workspace without server secrets",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporaryDirectory;
          const workspace = join(directory, "workspace");
          const secret = "sk-test-provider-secret";
          const previous = process.env.OPENCODE_GO_API_KEY;
          process.env.OPENCODE_GO_API_KEY = secret;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env.OPENCODE_GO_API_KEY;
              else process.env.OPENCODE_GO_API_KEY = previous;
            }),
          );

          const faux = fauxProvider({ tokensPerSecond: 0 });
          faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall("bash", { command: "pwd && env" }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("Ran it."),
            fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), {
              stopReason: "toolUse",
            }),
            fauxAssistantMessage("Ran it in the branch."),
          ]);

          const runtime = createModels();
          runtime.setProvider(faux.provider);

          const layer = Chats.layer.pipe(
            Layer.provide(
              Layer.succeed(
                ModelCatalog,
                ModelCatalog.of({
                  runtime,
                  choices: [{ id: modelId, name: "Faux", provider: "faux" }],
                }),
              ),
            ),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  STILL_DATABASE: join(directory, "chat.sqlite"),
                  STILL_WORKSPACE: workspace,
                }),
              ),
            ),
          );

          yield* Effect.gen(function* () {
            const chats = yield* Chats;

            const settled = (id: number) =>
              chats.watch(id).pipe(
                Stream.filter(
                  (snapshot) =>
                    !snapshot.busy &&
                    snapshot.messages.some((item) =>
                      item.text.startsWith("Ran"),
                    ),
                ),
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              );

            const chat = yield* chats.create(modelId);
            yield* chats.send(chat.id, {
              text: "Where are you?",
              requestId: "agent-0001",
            });

            const first = yield* settled(chat.id);
            const shell = first.tools.find((tool) => tool.name === "bash");

            expect(shell?.failed).toBe(false);
            expect(shell?.text).toContain(workspace);
            expect(shell?.text).toContain("PATH=");
            expect(shell?.text).not.toContain(secret);

            const prompt = first.messages.find((item) => item.role === "user");

            const branch = yield* chats.branch(chat.id, {
              entry: prompt?.before ?? 0,
              model: modelId,
            });

            yield* chats.send(branch.id, {
              text: "And here?",
              requestId: "agent-0002",
            });

            const forked = yield* settled(branch.id);

            expect(
              forked.tools.find((tool) => tool.name === "bash")?.text,
            ).toContain(workspace);
          }).pipe(Effect.provide(layer));
        }),
      ),
  );
});
