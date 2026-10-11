import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Layer,
  Option,
  Stream,
} from "effect";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  Harness,
  createRegistry,
  defineDoc,
  defineTask,
  InboxDoc,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Chats } from "../src/server/chat.ts";
import { ModelCatalog } from "../src/server/models.ts";
import {
  GrantDoc,
  Kernel,
  environment,
  idle,
  initializeConversation,
  selectKit,
} from "../src/kernel/kits.ts";
import type { ChatSnapshot } from "../src/shared/contracts.ts";

const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "still-kits-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

function fixture(path: string) {
  const faux = fauxProvider({
    tokensPerSecond: 0,
    models: [
      {
        id: "a",
        cost: { input: 0, output: 1000000, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "b",
        cost: { input: 0, output: 2000000, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });

  const models = createModels();
  models.setProvider(faux.provider);

  const layer = Chats.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ModelCatalog,
        ModelCatalog.of({
          runtime: models,
          choices: models.getModels().map((model) => ({
            id: `faux/${model.id}`,
            name: model.name,
            provider: "faux",
          })),
        }),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          STILL_DATABASE: join(path, "chat.sqlite"),
          STILL_BUILDER_ROOT: path,
        }),
      ),
    ),
  );

  return { faux, models, layer };
}

function snapshot(
  chats: Chats["Service"],
  id: number,
  accept: (value: ChatSnapshot) => boolean = () => true,
) {
  return chats
    .watch(id)
    .pipe(Stream.filter(accept), Stream.runHead, Effect.map(Option.getOrThrow));
}

describe("fresh-state kit authority", () => {
  it.effect(
    "changes kits only when idle, refuses escalation, preserves queued/steered input and exposes live work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const test = fixture(directory);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          test.faux.setResponses([
            async (_request, options) => {
              await Effect.runPromise(Deferred.succeed(started, undefined));
              await Effect.runPromise(Deferred.await(release), {
                signal: options?.signal,
              });

              return fauxAssistantMessage("ABCD");
            },
            fauxAssistantMessage("EFGH"),
            fauxAssistantMessage("IJKL"),
          ]);
          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            const chat = yield* chats.create("faux/a");
            expect(chat.grant).toEqual({ kit: "chat", target: null });
            expect(
              yield* chats
                .kit(chat.id, { kit: "still", target: "candidate-test" })
                .pipe(Effect.flip),
            ).toMatchObject({ status: 403 });
            yield* chats.kit(chat.id, { kit: "research", target: null });
            expect((yield* snapshot(chats, chat.id)).grant.kit).toBe(
              "research",
            );
            yield* chats.send(chat.id, {
              text: "First",
              requestId: "kit-first",
            });
            yield* Deferred.await(started);
            expect(
              yield* chats
                .kit(chat.id, { kit: "chat", target: null })
                .pipe(Effect.flip),
            ).toMatchObject({ status: 409 });
            expect(
              yield* chats
                .send(chat.id, {
                  text: "Wrong model",
                  model: "faux/b",
                  requestId: "kit-model",
                })
                .pipe(Effect.flip),
            ).toMatchObject({ status: 409 });
            yield* chats.send(chat.id, {
              text: "Queued",
              whenBusy: "followUp",
              requestId: "kit-queued",
            });
            yield* chats.send(chat.id, {
              text: "Steer",
              whenBusy: "steer",
              requestId: "kit-steer",
            });
            expect((yield* snapshot(chats, chat.id)).queued).toBe(2);
            expect(
              (yield* chats.work()).some(
                (task) => task.conversationId === chat.id,
              ),
            ).toBe(true);
            yield* Deferred.succeed(release, undefined);

            const done = yield* snapshot(
              chats,
              chat.id,
              (value) =>
                !value.busy &&
                value.queued === 0 &&
                value.messages.some((item) => item.text === "Queued"),
            );

            // No tool boundary intervenes: Pi places both modes in admission order at final.
            expect(
              done.messages
                .filter((item) => item.role === "user")
                .map((item) => item.text),
            ).toEqual(["First", "Queued", "Steer"]);
            expect(done.model).toBe("faux/a");
            yield* chats.kit(chat.id, { kit: "chat", target: null });
            expect((yield* snapshot(chats, chat.id)).grant).toEqual({
              kit: "chat",
              target: null,
            });
          }).pipe(Effect.provide(test.layer));
        }),
      ),
  );

  it.effect(
    "selects the next model, accounts Pi cost, and branches before an edited prompt without inheriting authority",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const test = fixture(directory);
          const seen: string[] = [];
          test.faux.setResponses([
            (_request, _options, _state, model) => {
              seen.push(model.id);

              return fauxAssistantMessage("ABCD");
            },
            (_request, _options, _state, model) => {
              seen.push(model.id);

              return fauxAssistantMessage("EFGH");
            },
            (request, _options, _state, model) => {
              seen.push(model.id);
              expect(
                request.messages
                  .filter((item) => item.role === "user")
                  .map((item) => item.content),
              ).toEqual(["Edited prompt"]);
              expect(
                request.messages.flatMap((item) =>
                  item.role === "system" ? (item.toolsAdded ?? []) : [],
                ),
              ).toHaveLength(0);

              return fauxAssistantMessage("IJKL");
            },
          ]);
          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            const chat = yield* chats.create("faux/a");
            yield* chats.kit(chat.id, { kit: "research", target: null });
            yield* chats.send(chat.id, {
              text: "Original prompt",
              requestId: "model-first",
            });

            const first = yield* snapshot(
              chats,
              chat.id,
              (value) =>
                !value.busy &&
                value.messages.some((item) => item.text === "ABCD"),
            );

            // Faux deliberately reports zero cost, independently of its model catalog rates.
            expect(first.cost).toBe(0);
            yield* chats.send(chat.id, {
              text: "Next prompt",
              model: "faux/b",
              requestId: "model-next",
            });

            const next = yield* snapshot(
              chats,
              chat.id,
              (value) =>
                !value.busy &&
                value.messages.some((item) => item.text === "EFGH"),
            );

            expect(next.cost).toBe(0);
            expect(
              next.changes.some((change) => change.text === "Model: faux/b"),
            ).toBe(true);

            const before = first.messages.find(
              (item) => item.role === "user",
            )?.before;

            if (!before) throw new Error("Missing safe branch boundary");

            const child = yield* chats.branch(chat.id, {
              entry: before,
              model: "faux/a",
            });

            const empty = yield* snapshot(chats, child.id);
            expect(empty.grant).toEqual({ kit: "chat", target: null });
            expect(empty.parent).toBe(chat.id);
            expect(empty.cost).toBe(0);
            yield* chats.send(child.id, {
              text: "Edited prompt",
              requestId: "branch-edit",
            });
            yield* snapshot(
              chats,
              child.id,
              (value) =>
                !value.busy &&
                value.messages.some((item) => item.text === "IJKL"),
            );
            expect(seen).toEqual(["a", "b", "a"]);
            expect(
              (yield* snapshot(chats, chat.id)).messages.map(
                (item) => item.text,
              ),
            ).toEqual(["Original prompt", "ABCD", "Next prompt", "EFGH"]);
          }).pipe(Effect.provide(test.layer));
        }),
      ),
  );

  it.effect(
    "denies forged coding calls in Chat and Research, even though coding tools are registered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const test = fixture(directory);
          test.faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall("bash", { command: "touch forbidden" }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("Denied"),
            fauxAssistantMessage(
              fauxToolCall("write", { path: "forbidden", content: "bad" }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("Also denied"),
          ]);
          yield* Effect.gen(function* () {
            const chats = yield* Chats;

            for (const kit of ["chat", "research"] as const) {
              const chat = yield* chats.create("faux/a");
              yield* chats.kit(chat.id, { kit, target: null });
              yield* chats.send(chat.id, {
                text: "Try a coding tool",
                requestId: `forged-${kit}`,
              });

              const done = yield* snapshot(
                chats,
                chat.id,
                (value) => !value.busy && value.tools.length === 1,
              );

              expect(done.tools[0]?.failed).toBe(true);
            }
          }).pipe(Effect.provide(test.layer));
        }),
      ),
  );

  it.effect(
    "resets raw children/forks, withholds mismatched env, and rejects inbox-only changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const target = "candidate-test";
          yield* Effect.promise(() => mkdir(join(directory, target)));
          const test = fixture(directory);
          const registry = createRegistry();
          registry.install(Kernel);

          const harness = yield* Effect.acquireRelease(
            Effect.promise(async () =>
              Harness.open(
                await openNodeSqliteStorage(join(directory, "raw.sqlite")),
                {
                  models: test.models,
                  registry,
                  conversationCreated: initializeConversation,
                },
                context,
              ),
            ),
            (value) => Effect.promise(() => value.close(context)),
          );

          yield* Effect.promise(async () => {
            const parent = await harness.createConversation(
              { ownership: { kind: "ownerless" } },
              context,
            );

            const at = await parent.commit(async (tx) => {
              const grant = await tx.doc(GrantDoc, parent.id);
              grant.kit = "still";
              grant.target = target;
              await selectKit(tx, parent.id, grant, directory);

              return (
                await tx.appendEntry(parent.id, { kind: "test.boundary" })
              ).id;
            }, context);

            expect(
              await environment(
                directory,
                { conversationId: parent.id, cwd: directory, read: harness },
                context,
              ),
            ).toBeUndefined();
            expect(
              await environment(
                directory,
                {
                  conversationId: parent.id,
                  cwd: join(directory, target),
                  read: harness,
                },
                context,
              ),
            ).toBeDefined();

            const owner = defineTask<null, { phase: "hold" }, null>({
              name: "test.owner",
              version: 1,
              initial: () => ({ phase: "hold" }),
              phases: { hold: async () => {} },
              abort: async () => {},
            });

            const children = await harness.commit(async (tx) => {
              const taskId = await tx.createTask(owner, null, {
                conversationId: parent.id,
                ownership: { kind: "conversation" },
              });

              const child = await tx.createConversation({
                ownership: { kind: "task", taskId },
              });

              const fork = await tx.forkConversation(parent.id, at, {
                ownership: { kind: "ownerless" },
              });

              return [child.id, fork.id];
            }, context);

            for (const id of children) {
              expect(await harness.snapshot(GrantDoc, id, context)).toEqual({
                kit: "chat",
                target: null,
              });
              expect(
                await harness.snapshot(AgentDoc, id, context),
              ).toMatchObject({ tools: [] });
              expect(
                (await harness.snapshot(AgentDoc, id, context))?.cwd,
              ).toBeUndefined();
              expect(
                await environment(
                  directory,
                  {
                    conversationId: id,
                    cwd: join(directory, target),
                    read: harness,
                  },
                  context,
                ),
              ).toBeUndefined();
            }

            await parent.commit(async (tx) => {
              const record = await tx.createSubmission({
                conversationId: parent.id,
                type: "input",
                status: "queued",
              });

              const inbox = await tx.doc(InboxDoc, parent.id);
              inbox.items.push({
                id: record.id,
                mode: "followUp",
                content: "Queued",
              });
            }, context);
            await expect(
              parent.commit((tx) => idle(tx, parent.id), context),
            ).rejects.toMatchObject({ status: 409 });
          });
        }),
      ),
  );

  it.effect(
    "projects persisted costs across models and tools without charging a branch for its parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const test = fixture(directory);

          const seeded = yield* Effect.promise(async () => {
            const harness = await Harness.open(
              await openNodeSqliteStorage(join(directory, "chat.sqlite")),
              {
                models: test.models,
                registry: createRegistry(),
                conversationCreated: initializeConversation,
              },
              context,
            );

            try {
              return await harness.commit(async (tx) => {
                const chat = await tx.createConversation({
                  ownership: { kind: "ownerless" },
                });

                const usage = await tx.doc(UsageDoc, chat.id);
                const base = fauxAssistantMessage("Fixture").usage;
                usage.models["faux/a"] = {
                  ...base,
                  cost: { ...base.cost, total: 0.125 },
                };
                usage.models["faux/b"] = {
                  ...base,
                  cost: { ...base.cost, total: 0.5 },
                };
                usage.tools["lookup"] = {
                  ...base,
                  cost: { ...base.cost, total: 0.25 },
                };

                const entry = await tx.appendEntry(chat.id, {
                  kind: "test.boundary",
                });

                return { id: chat.id, entry: entry.id };
              }, context);
            } finally {
              await harness.close(context);
            }
          });

          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            expect((yield* snapshot(chats, seeded.id)).cost).toBe(0.875);

            const branch = yield* chats.branch(seeded.id, {
              entry: seeded.entry,
              model: "faux/a",
            });

            expect((yield* snapshot(chats, branch.id)).cost).toBe(0);
            expect(test.faux.state.callCount).toBe(0);
          }).pipe(Effect.provide(test.layer));
        }),
      ),
  );

  it.effect(
    "refuses the old database without migrating its conversation metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const test = fixture(directory);

          const legacy = defineDoc({
            kind: "still.chat",
            version: 1,
            scope: "conversation",
            history: "latest",
            fork: "initial",
            initial: () => ({ title: "Preserve me", model: "faux/a" }),
          });

          const id = yield* Effect.promise(async () => {
            const old = await Harness.open(
              await openNodeSqliteStorage(join(directory, "chat.sqlite")),
              { models: test.models, registry: createRegistry() },
              context,
            );

            try {
              return (
                await old.createConversation(
                  {
                    ownership: { kind: "ownerless" },
                    init: async (tx, id) => {
                      await tx.doc(legacy, id);
                    },
                  },
                  context,
                )
              ).id;
            } finally {
              await old.close(context);
            }
          });

          const failure = yield* Effect.gen(function* () {
            const chats = yield* Chats;

            return yield* chats.list();
          }).pipe(Effect.provide(test.layer), Effect.flip);

          expect(failure).toMatchObject({ status: 503 });
          yield* Effect.promise(async () => {
            const old = await Harness.open(
              await openNodeSqliteStorage(join(directory, "chat.sqlite")),
              { models: test.models, registry: createRegistry() },
              context,
            );

            try {
              expect(await old.snapshot(legacy, id, context)).toEqual({
                title: "Preserve me",
                model: "faux/a",
              });
            } finally {
              await old.close(context);
            }
          });
          expect(test.faux.state.callCount).toBe(0);
        }),
      ),
  );
});
