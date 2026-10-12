import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Chats, ChatFailure } from "../src/server/chat.ts";
import { ModelCatalog } from "../src/server/models.ts";
import {
  ChatId,
  ChatSnapshot,
  CreateChat,
  SendMessage,
} from "../src/shared/contracts.ts";

const modelId = "faux/faux-1";

const temporaryDatabase = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "still-chat-test-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "chat.sqlite")));

function testLayer(
  database: string,
  responses: readonly string[],
  offered = [{ id: modelId, name: "Faux Model", provider: "faux" }],
) {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  faux.setResponses(responses.map((text) => fauxAssistantMessage(text)));

  const runtime = createModels();
  runtime.setProvider(faux.provider);

  const catalog = Layer.succeed(
    ModelCatalog,
    ModelCatalog.of({
      runtime,
      choices: offered,
    }),
  );

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ STILL_DATABASE: database }),
  );

  return {
    layer: Chats.layer.pipe(Layer.provide(catalog), Layer.provide(config)),
    faux,
  };
}

const snapshotWithAnswer = <E>(
  chats: {
    readonly watch: (id: number) => Stream.Stream<ChatSnapshot, E>;
  },
  id: number,
) =>
  chats.watch(id).pipe(
    Stream.filter(
      (snapshot) =>
        !snapshot.busy &&
        snapshot.messages.some((item) => item.role === "assistant"),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(new Error("chat watch ended without an answer")),
        onSome: Effect.succeed,
      }),
    ),
  );

describe("Chats with Durable SQLite", () => {
  it.effect("queues a follow-up while a response is running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const fixture = testLayer(database, []);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fixture.faux.setResponses([
          async () => {
            await Effect.runPromise(Deferred.succeed(started, undefined));
            await Effect.runPromise(Deferred.await(release));

            return fauxAssistantMessage("First reply");
          },
          fauxAssistantMessage("Follow-up reply"),
        ]);
        yield* Effect.gen(function* () {
          const chats = yield* Chats;
          const chat = yield* chats.create(modelId);
          yield* chats.send(chat.id, {
            text: "First",
            requestId: "queue-first",
          });
          yield* Deferred.await(started);
          yield* chats.send(chat.id, {
            text: "Second",
            requestId: "queue-second",
          });

          const queued = yield* chats
            .watch(chat.id)
            .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

          expect(queued.busy).toBe(true);
          expect(queued.queued).toBe(1);
          yield* Deferred.succeed(release, undefined);

          const done = yield* chats.watch(chat.id).pipe(
            Stream.filter(
              (value) =>
                !value.busy &&
                value.messages.filter((item) => item.role === "assistant")
                  .length === 2,
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );

          expect(done.messages.map((item) => item.text)).toEqual([
            "First",
            "First reply",
            "Second",
            "Follow-up reply",
          ]);
          expect(done.queued).toBe(0);
        }).pipe(
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
      }),
    ),
  );

  it.effect("stops an active generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const fixture = testLayer(database, []);
        const started = yield* Deferred.make<void>();
        fixture.faux.setResponses([
          async (_context, options) => {
            await Effect.runPromise(Deferred.succeed(started, undefined));
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) resolve();
              else
                options?.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });

            return fauxAssistantMessage("", { stopReason: "aborted" });
          },
        ]);
        yield* Effect.gen(function* () {
          const chats = yield* Chats;
          const chat = yield* chats.create(modelId);
          yield* chats.send(chat.id, {
            text: "Stop me",
            requestId: "stop-request",
          });
          yield* Deferred.await(started);
          yield* chats.stop(chat.id);

          const stopped = yield* chats.watch(chat.id).pipe(
            Stream.filter((value) => !value.busy),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );

          expect(stopped.busy).toBe(false);
          // Durable deliberately omits an empty assistant entry when stopped before any text.
          expect(stopped.messages.map((item) => item.role)).toEqual(["user"]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps owner feedback once per request and across restarts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;

        const note = {
          text: "Streaming felt janky on the phone",
          requestId: "feedback-0001",
          conversationId: null,
          context: "chat · chat · faux-1 · 390x844",
        };

        yield* Effect.gen(function* () {
          const chats = yield* Chats;
          yield* chats.feedback(note, "test-release");
          yield* chats.feedback(note, "test-release");
          yield* chats.feedback(
            { ...note, text: "Second note", requestId: "feedback-0002" },
            "test-release",
          );
        }).pipe(Effect.provide(testLayer(database, []).layer));

        const items = yield* Effect.gen(function* () {
          const chats = yield* Chats;

          return yield* chats.feedbackList();
        }).pipe(Effect.provide(testLayer(database, []).layer));

        expect(items.map((item) => item.text)).toEqual([
          "Second note",
          "Streaming felt janky on the phone",
        ]);
        expect(items[1]).toMatchObject({
          id: "feedback-0001",
          context: note.context,
          release: "test-release",
        });
      }),
    ),
  );

  it.effect("rejects provider models that are not offered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const hidden = testLayer(database, ["Unused"], []);

        const failure = yield* Effect.gen(function* () {
          const chats = yield* Chats;

          return yield* chats.create(modelId).pipe(Effect.flip);
        }).pipe(Effect.provide(hidden.layer));

        expect(failure).toBeInstanceOf(ChatFailure);
        expect(failure.status).toBe(400);
      }),
    ),
  );

  it.effect("creates, watches, completes once, and survives reopening", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const first = testLayer(database, ["Deterministic answer"]);

        const persisted = yield* Effect.scoped(
          Effect.gen(function* () {
            const chats = yield* Chats;

            const invalid = yield* chats
              .create("missing/model")
              .pipe(Effect.flip);

            expect(invalid).toBeInstanceOf(ChatFailure);
            expect(invalid.status).toBe(400);

            const missing = yield* chats
              .watch(99999)
              .pipe(Stream.runHead, Effect.flip);

            expect(missing).toBeInstanceOf(ChatFailure);
            expect(missing).toMatchObject({ status: 404 });

            const created = yield* chats.create(modelId);
            expect(created).toMatchObject({
              title: "New conversation",
              model: modelId,
            });

            const initial = yield* chats.watch(created.id).pipe(Stream.runHead);
            expect(Option.getOrThrow(initial)).toMatchObject({
              ...created,
              messages: [],
              busy: false,
              queued: 0,
              cost: 0,
              tools: [],
            });

            const input = {
              text: "Remember this after reopening",
              requestId: "request-0001",
            };

            const firstReceipt = yield* chats.send(created.id, input);
            const duplicateReceipt = yield* chats.send(created.id, input);

            expect(duplicateReceipt).toEqual(firstReceipt);

            const completed = yield* snapshotWithAnswer(chats, created.id);
            expect(completed.title).toBe(input.text);
            expect(
              completed.messages.map(({ role, text }) => ({ role, text })),
            ).toEqual([
              { role: "user", text: input.text },
              { role: "assistant", text: "Deterministic answer" },
            ]);
            expect(first.faux.state.callCount).toBe(1);

            return { created, completed };
          }).pipe(Effect.provide(first.layer)),
        );

        const reopened = testLayer(database, []);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const chats = yield* Chats;
            expect(yield* chats.list()).toEqual([
              {
                id: persisted.created.id,
                title: "Remember this after reopening",
                model: modelId,
                grant: { kit: "chat", target: null },
              },
            ]);

            const snapshot = yield* chats
              .watch(persisted.created.id)
              .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

            expect(snapshot).toEqual(persisted.completed);
            expect(reopened.faux.state.callCount).toBe(0);
          }).pipe(Effect.provide(reopened.layer)),
        );
      }),
    ),
  );
});

describe("shared chat contracts", () => {
  it.effect(
    "accepts service snapshots and rejects malformed boundary input",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Schema.decodeUnknownEffect(ChatSnapshot)({
          id: 1,
          title: "A chat",
          model: modelId,
          grant: { kit: "chat", target: null },
          messages: [],
          busy: false,
          queued: 0,
          cost: 0,
          tools: [],
          changes: [],
          attachments: [],
          citations: [],
          confirmations: [],
        });

        expect(snapshot.id).toBe(1);

        const invalidId = yield* Schema.decodeUnknownEffect(ChatId)(0).pipe(
          Effect.flip,
        );

        const invalidCreate = yield* Schema.decodeUnknownEffect(CreateChat)({
          model: "",
        }).pipe(Effect.flip);

        const invalidMessage = yield* Schema.decodeUnknownEffect(SendMessage)({
          text: "   ",
          requestId: "short",
        }).pipe(Effect.flip);

        expect(invalidId).toBeDefined();
        expect(invalidCreate).toBeDefined();
        expect(invalidMessage).toBeDefined();
      }),
  );
});
