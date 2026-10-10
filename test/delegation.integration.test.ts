import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { Chats } from "../src/server/chat.ts";
import { ModelCatalog } from "../src/server/models.ts";
import { digest } from "../src/server/audit.ts";
import type {
  ChatSnapshot,
  Group,
  LaunchGroup,
} from "../src/shared/contracts.ts";

const modelA = "faux/faux-a";

const modelB = "faux/faux-b";

const database = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "still-delegation-"))),
  (path) => Effect.promise(() => rm(path, { force: true, recursive: true })),
).pipe(Effect.map((path) => join(path, "test.sqlite")));

function fixture(path: string, response: FauxResponseFactory) {
  const faux = fauxProvider({
    tokensPerSecond: 0,
    models: [{ id: "faux-a" }, { id: "faux-b" }],
  });

  faux.setResponses(Array.from({ length: 50 }, () => response));
  const runtime = createModels();
  runtime.setProvider(faux.provider);

  const catalog = Layer.succeed(
    ModelCatalog,
    ModelCatalog.of({
      runtime,
      choices: [
        { id: modelA, name: "Faux A", provider: "faux" },
        { id: modelB, name: "Faux B", provider: "faux" },
      ],
    }),
  );

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ STILL_DATABASE: path }),
  );

  return {
    faux,
    layer: Chats.layer.pipe(Layer.provide(catalog), Layer.provide(config)),
  };
}

function snapshot(
  chats: Chats["Service"],
  id: number,
  accept: (value: ChatSnapshot) => boolean,
) {
  return chats
    .watch(id)
    .pipe(Stream.filter(accept), Stream.runHead, Effect.map(Option.getOrThrow));
}

function settled(chats: Chats["Service"], id: number, group: string) {
  return snapshot(
    chats,
    id,
    (value) =>
      value.groups?.some(
        (item) =>
          item.id === group &&
          item.candidates.every(
            (child) =>
              child.status !== "running" &&
              child.status !== "queued" &&
              child.status !== "cancelling",
          ),
      ) ?? false,
  ).pipe(
    Effect.map((value) => {
      const result = value.groups?.find((item) => item.id === group);

      if (!result) throw new Error("Missing group");

      return result;
    }),
  );
}

function action(
  group: Group,
  kind: "return" | "retry" | "cancel" | "stop" | "synthesize",
  slot = 0,
  requestId = `action-${kind}-${slot}`,
) {
  return { groupId: group.id, action: kind, slot, requestId, model: modelA };
}

describe("durable delegation", () => {
  for (const cancelBeforeCrash of [false, true]) {
    it.effect(
      cancelBeforeCrash
        ? "persists cancellation across SIGKILL without restarting inference"
        : "survives SIGKILL without duplicate children or prompt placement",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const path = yield* database;

            const child = yield* Effect.acquireRelease(
              Effect.sync(() =>
                fork(
                  new URL("./fixtures/crash-worker.ts", import.meta.url),
                  [path],
                  {
                    execArgv: ["--import", "tsx"],
                    stdio: ["ignore", "ignore", "inherit", "ipc"],
                  },
                ),
              ),
              (process) =>
                Effect.sync(() => {
                  if (process.exitCode === null && process.signalCode === null)
                    process.kill("SIGKILL");
                }),
            );

            const started = yield* Effect.promise(
              () =>
                new Promise<unknown>((resolve, reject) => {
                  child.once("message", resolve);
                  child.once("error", reject);
                  child.once("exit", (code) =>
                    reject(new Error(`Crash fixture exited early: ${code}`)),
                  );
                }),
            );

            const state = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                parentId: Schema.Number,
                childId: Schema.Number,
                sessionHash: Schema.String,
                requestHash: Schema.String,
              }),
            )(started);

            if (cancelBeforeCrash) {
              const cancelled = yield* Effect.promise(
                () =>
                  new Promise<unknown>((resolve) => {
                    child.once("message", resolve);
                    child.send("cancel");
                  }),
              );

              expect(cancelled).toEqual({ cancelAdmitted: true });
            }

            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  child.once("exit", () => resolve());
                  child.kill("SIGKILL");
                }),
            );
            expect(child.signalCode).toBe("SIGKILL");

            const reopened = fixture(path, (context, options) => {
              expect(digest(JSON.stringify(context.messages))).toBe(
                state.requestHash,
              );
              expect(digest(options?.sessionId ?? "")).toBe(state.sessionHash);

              return fauxAssistantMessage("Hard-crash recovered answer");
            });

            yield* Effect.gen(function* () {
              const chats = yield* Chats;

              const done = yield* settled(
                chats,
                state.parentId,
                "hard-crash-arena",
              );

              expect(done.candidates[0]?.conversationId).toBe(state.childId);

              if (cancelBeforeCrash) {
                expect(done.candidates[0]?.status).toBe("cancelled");
                expect(done.cancelled).toBe(true);
                expect(reopened.faux.state.callCount).toBe(0);

                return;
              }

              expect(done.candidates[0]?.answer).toBe(
                "Hard-crash recovered answer",
              );

              const childView = yield* snapshot(
                chats,
                state.childId,
                () => true,
              );

              expect(childView.messages.map((item) => item.text)).toEqual([
                "Hard crash recovery task",
                "Hard-crash recovered answer",
              ]);
              expect(yield* chats.list()).toHaveLength(2);

              const replay = yield* chats.launch(state.parentId, {
                task: "Hard crash recovery task",
                mode: "fresh",
                sourceEntry: null,
                models: [modelA],
                requestId: "hard-crash-arena",
              });

              expect(replay.candidates[0]?.conversationId).toBe(state.childId);
              expect(reopened.faux.state.callCount).toBe(1);
            }).pipe(Effect.provide(reopened.layer));
          }),
        ),
    );
  }

  it.effect(
    "freezes context, runs five slots concurrently, isolates failure and divergence, and returns only explicitly",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* database;
          const started = yield* Queue.unbounded<string>();
          const release = yield* Deferred.make<void>();

          const calls: {
            model: string;
            messages: string;
            session: string;
            tools: number;
          }[] = [];

          const setup = fixture(
            path,
            async (context, options, _state, model) => {
              const content = JSON.stringify(context.messages);
              calls.push({
                model: model.id,
                messages: content,
                session: options?.sessionId ?? "",
                tools: context.messages.flatMap((item) =>
                  item.role === "system" ? (item.toolsAdded ?? []) : [],
                ).length,
              });

              if (content.includes("ARENA_TASK_71")) {
                await Effect.runPromise(Queue.offer(started, model.id));
                await Effect.runPromise(Deferred.await(release));

                if (model.id === "faux-b")
                  return fauxAssistantMessage("", {
                    stopReason: "error",
                    errorMessage: "Fixture rejection",
                  });

                return fauxAssistantMessage(`INDEPENDENT_${calls.length}`);
              }

              return fauxAssistantMessage("PARENT_OR_CONTINUATION");
            },
          );

          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            const parent = yield* chats.create(modelA);
            yield* chats.send(parent.id, {
              text: "FROZEN_FACT_23",
              requestId: "seed-fact",
            });

            const seed = yield* snapshot(
              chats,
              parent.id,
              (value) =>
                !value.busy &&
                value.messages.some((item) => item.role === "assistant"),
            );

            const boundary = seed.entries?.at(-1)?.id;
            expect(boundary).toBeDefined();
            yield* chats.send(parent.id, {
              text: "EXCLUDED_BEFORE_LAUNCH",
              requestId: "parent-before",
            });
            yield* snapshot(
              chats,
              parent.id,
              (value) => !value.busy && value.messages.length === 4,
            );

            const input: LaunchGroup = {
              task: "ARENA_TASK_71",
              mode: "fork",
              sourceEntry: boundary ?? null,
              models: [modelA, modelB, modelA, modelA, modelA],
              requestId: "arena-frozen",
            };

            const group = yield* chats.launch(parent.id, input);
            const duplicate = yield* chats.launch(parent.id, input);
            expect(
              duplicate.candidates.map((item) => item.conversationId),
            ).toEqual(group.candidates.map((item) => item.conversationId));

            for (let slot = 0; slot < 5; slot++) yield* Queue.take(started);
            const concurrent = calls.slice(2);
            expect(concurrent).toHaveLength(5);
            expect(new Set(concurrent.map((item) => item.session)).size).toBe(
              5,
            );

            for (const call of concurrent) {
              expect(call.messages).toContain("FROZEN_FACT_23");
              expect(call.messages).not.toContain("EXCLUDED_BEFORE_LAUNCH");
              expect(call.messages).not.toContain("INDEPENDENT_");
              expect(call.messages.match(/ARENA_TASK_71/g)).toHaveLength(1);
              expect(call.tools).toBe(0);
            }

            yield* chats.stop(parent.id); // Ordinary stop must not cross background anchors.
            yield* chats.send(parent.id, {
              text: "EXCLUDED_AFTER_LAUNCH",
              requestId: "parent-after",
            });
            yield* snapshot(
              chats,
              parent.id,
              (value) =>
                !value.busy &&
                value.messages.some(
                  (item) => item.text === "EXCLUDED_AFTER_LAUNCH",
                ),
            );
            const observed = yield* Deferred.make<void>();

            const liveObserver = yield* chats.watch(parent.id).pipe(
              Stream.mapEffect((value) =>
                Deferred.succeed(observed, undefined).pipe(Effect.as(value)),
              ),
              Stream.filter(
                (value) =>
                  value.groups?.[0]?.candidates.every(
                    (item) =>
                      item.status !== "queued" && item.status !== "running",
                  ) ?? false,
              ),
              Stream.runHead,
              Effect.forkScoped,
            );

            yield* Deferred.await(observed);
            yield* Deferred.succeed(release, undefined);
            expect(Option.isSome(yield* Fiber.join(liveObserver))).toBe(true);
            const done = yield* settled(chats, parent.id, group.id);
            expect(done.candidates.map((item) => item.status)).toEqual([
              "completed",
              "failed",
              "completed",
              "completed",
              "completed",
            ]);
            const untouched = yield* snapshot(chats, parent.id, () => true);
            expect(
              untouched.messages.some((item) =>
                item.text.includes("INDEPENDENT_"),
              ),
            ).toBe(false);

            const first = done.candidates[0];
            const second = done.candidates[2];

            if (!first || !second) throw new Error("Missing candidates");

            const audits = yield* Effect.all([
              chats.audit(first.conversationId),
              chats.audit(second.conversationId),
            ]);

            expect(audits[0]?.requests[0]?.messages.slice(0, -1)).toEqual(
              audits[1]?.requests[0]?.messages.slice(0, -1),
            );
            expect(audits[0]?.requests[0]?.sessionHash).not.toEqual(
              audits[1]?.requests[0]?.sessionHash,
            );
            expect(JSON.stringify(audits)).not.toContain("FROZEN_FACT_23");

            yield* chats.send(first.conversationId, {
              text: "CHILD_ONLY_DIVERGENCE",
              requestId: "child-diverge",
            });
            yield* snapshot(
              chats,
              first.conversationId,
              (value) =>
                !value.busy &&
                value.messages.some(
                  (item) => item.text === "CHILD_ONLY_DIVERGENCE",
                ),
            );

            const other = yield* snapshot(
              chats,
              second.conversationId,
              () => true,
            );

            expect(
              other.messages.some((item) =>
                item.text.includes("CHILD_ONLY_DIVERGENCE"),
              ),
            ).toBe(false);

            const recursive = yield* chats
              .launch(first.conversationId, {
                ...input,
                mode: "fresh",
                sourceEntry: null,
                requestId: "no-recursion",
              })
              .pipe(Effect.flip);

            expect(recursive).toMatchObject({ status: 400 });

            const beforeReturn = setup.faux.state.callCount;

            const returned = yield* chats.groupAction(
              parent.id,
              action(done, "return"),
            );

            expect(
              yield* chats.groupAction(
                parent.id,
                action(done, "return", 0, "different-return-id"),
              ),
            ).toEqual(returned);

            const withResult = yield* snapshot(chats, parent.id, (value) =>
              value.messages.some((item) =>
                item.text.startsWith("Selected result"),
              ),
            );

            expect(
              withResult.messages.filter((item) =>
                item.text.startsWith("Selected result"),
              ),
            ).toHaveLength(1);
            expect(setup.faux.state.callCount).toBe(beforeReturn);

            yield* chats.groupAction(parent.id, action(done, "retry", 1));
            yield* chats.groupAction(parent.id, action(done, "retry", 1));
            const retry = yield* settled(chats, parent.id, group.id);
            expect(retry.candidates[1]?.attempt).toBe(2);
            expect(retry.candidates[1]?.conversationId).not.toBe(
              done.candidates[1]?.conversationId,
            );

            const fresh = yield* chats.launch(parent.id, {
              ...input,
              mode: "fresh",
              sourceEntry: null,
              task: "FRESH_TASK",
              models: [modelA],
              requestId: "fresh-context",
            });

            yield* settled(chats, parent.id, fresh.id);
            expect(calls.at(-1)?.messages).not.toContain("FROZEN_FACT_23");
            expect(calls.at(-1)?.messages).not.toContain("Selected result");
            yield* chats.groupAction(
              parent.id,
              action(done, "synthesize", 0, "synthesis-request"),
            );
            yield* settled(chats, parent.id, "synthesis-request");
            expect(calls.at(-1)?.messages).toContain(
              "Synthesize the following independent answers",
            );
            expect(calls.at(-1)?.messages).not.toContain(
              "CHILD_ONLY_DIVERGENCE",
            );
            expect(calls.at(-1)?.messages).not.toContain(
              "EXCLUDED_AFTER_LAUNCH",
            );
          }).pipe(
            Effect.provide(setup.layer),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
        }),
      ),
  );

  it.effect(
    "synthesizes five full 4000-character answers without weakening user limits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* database;

          const answers = Array.from({ length: 5 }, (_, slot) => {
            const marker = `FULL_ANSWER_${slot}_`;

            return marker + String(slot).repeat(4000 - marker.length);
          });

          const synthesisRequests: string[] = [];
          let answerIndex = 0;

          const setup = fixture(path, (context) => {
            const request = JSON.stringify(context.messages);

            if (
              request.includes("Synthesize the following independent answers")
            ) {
              synthesisRequests.push(request);

              return fauxAssistantMessage("Large synthesis completed");
            }

            return fauxAssistantMessage(
              answers[answerIndex++] ?? "Extra request",
            );
          });

          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            const parent = yield* chats.create(modelA);

            const group = yield* chats.launch(parent.id, {
              task: "Compare five designs",
              mode: "fresh",
              sourceEntry: null,
              models: [modelA, modelA, modelA, modelA, modelA],
              requestId: "large-source-arena",
            });

            yield* settled(chats, parent.id, group.id);

            const receipt = yield* chats.groupAction(
              parent.id,
              action(group, "synthesize", 0, "large-synthesis"),
            );

            const done = yield* settled(chats, parent.id, "large-synthesis");
            expect(receipt.id).toBe(done.coordinatorId);
            expect(done.task.length).toBeGreaterThan(20000);
            expect(done.candidates[0]?.answer).toBe(
              "Large synthesis completed",
            );
            expect(synthesisRequests).toHaveLength(1);

            for (const answer of answers)
              expect(synthesisRequests[0]).toContain(answer);
            expect(setup.faux.state.callCount).toBe(6);

            const rejected = yield* chats
              .launch(parent.id, {
                task: "x".repeat(16001),
                mode: "fresh",
                sourceEntry: null,
                models: [modelA],
                requestId: "oversized-user-task",
              })
              .pipe(Effect.flip);

            expect(rejected._tag).toBe("SchemaError");
            expect(setup.faux.state.callCount).toBe(6);
          }).pipe(Effect.provide(setup.layer));
        }),
      ),
  );

  it.effect(
    "rejects oversized synthesis context without truncation or admitting work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* database;

          const setup = fixture(path, () =>
            fauxAssistantMessage("Z".repeat(26000)),
          );

          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            const parent = yield* chats.create(modelA);

            const group = yield* chats.launch(parent.id, {
              task: "Compare very large results",
              mode: "fresh",
              sourceEntry: null,
              models: [modelA, modelA, modelA, modelA, modelA],
              requestId: "oversized-source-arena",
            });

            yield* settled(chats, parent.id, group.id);
            const before = yield* chats.list();

            const failure = yield* chats
              .groupAction(
                parent.id,
                action(group, "synthesize", 0, "oversized-synthesis"),
              )
              .pipe(Effect.flip);

            expect(failure._tag).toBe("ChatFailure");
            expect(failure).toMatchObject({ status: 413 });
            expect(failure.message).toContain("128000");
            expect(failure.message).toContain(
              "No synthesis workload was started",
            );
            expect(yield* chats.list()).toEqual(before);
            expect(
              (yield* snapshot(chats, parent.id, () => true)).groups,
            ).toHaveLength(1);
            expect(setup.faux.state.callCount).toBe(5);
          }).pipe(Effect.provide(setup.layer));
        }),
      ),
  );

  it.effect(
    "freezes synthesis admission across late completion, retry, concurrent replay and reopen",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* database;
          const release = yield* Deferred.make<void>();
          const synthesisRequests: string[] = [];
          let firstAttempts = 0;

          const setup = fixture(
            path,
            async (context, options, _state, model) => {
              const request = JSON.stringify(context.messages);

              if (
                request.includes("Synthesize the following independent answers")
              ) {
                synthesisRequests.push(request);

                return fauxAssistantMessage("Frozen synthesis answer");
              }

              if (model.id === "faux-b") {
                await Effect.runPromise(Deferred.await(release), {
                  signal: options?.signal,
                });

                return fauxAssistantMessage("LATE_SECOND_ANSWER");
              }

              return fauxAssistantMessage(
                firstAttempts++ === 0
                  ? "FIRST_FROZEN_ANSWER"
                  : "REPLACEMENT_FIRST_ANSWER",
              );
            },
          );

          const persisted = yield* Effect.scoped(
            Effect.gen(function* () {
              const chats = yield* Chats;
              const parent = yield* chats.create(modelA);

              const group = yield* chats.launch(parent.id, {
                task: "Compare staggered answers",
                mode: "fresh",
                sourceEntry: null,
                models: [modelA, modelB],
                requestId: "staggered-source-arena",
              });

              yield* snapshot(
                chats,
                parent.id,
                (value) =>
                  value.groups?.[0]?.candidates[0]?.status === "completed" &&
                  value.groups?.[0]?.candidates[1]?.status === "running",
              );
              const input = action(group, "synthesize", 0, "frozen-synthesis");

              const receipts = yield* Effect.all(
                [
                  chats.groupAction(parent.id, input),
                  chats.groupAction(parent.id, input),
                ],
                { concurrency: "unbounded" },
              );

              expect(receipts[0]).toEqual(receipts[1]);

              const original = yield* settled(
                chats,
                parent.id,
                "frozen-synthesis",
              );

              expect(synthesisRequests).toHaveLength(1);
              expect(original.task).toContain("FIRST_FROZEN_ANSWER");
              expect(original.task).not.toContain("LATE_SECOND_ANSWER");
              yield* Deferred.succeed(release, undefined);
              yield* settled(chats, parent.id, group.id);
              yield* chats.groupAction(
                parent.id,
                action(group, "retry", 0, "replace-first"),
              );
              yield* settled(chats, parent.id, group.id);
              const beforeReplay = setup.faux.state.callCount;
              expect(yield* chats.groupAction(parent.id, input)).toEqual(
                receipts[0],
              );
              expect(setup.faux.state.callCount).toBe(beforeReplay);

              const replayed = yield* settled(
                chats,
                parent.id,
                "frozen-synthesis",
              );

              expect(replayed.task).toBe(original.task);
              expect(replayed.candidates[0]?.conversationId).toBe(
                original.candidates[0]?.conversationId,
              );
              expect(synthesisRequests).toHaveLength(1);
              expect(
                yield* chats
                  .groupAction(parent.id, { ...input, model: modelB })
                  .pipe(Effect.flip),
              ).toMatchObject({ status: 409 });
              yield* chats.groupAction(parent.id, {
                ...input,
                requestId: "new-synthesis",
              });
              const updated = yield* settled(chats, parent.id, "new-synthesis");
              expect(updated.task).toContain("REPLACEMENT_FIRST_ANSWER");
              expect(updated.task).toContain("LATE_SECOND_ANSWER");
              expect(updated.task).not.toContain("FIRST_FROZEN_ANSWER");

              return {
                parent,
                input,
                receipt: receipts[0],
                task: original.task,
              };
            }).pipe(
              Effect.provide(setup.layer),
              Effect.ensuring(Deferred.succeed(release, undefined)),
            ),
          );

          const reopened = fixture(path, () =>
            fauxAssistantMessage("Unexpected inference"),
          );

          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            expect(
              yield* chats.groupAction(persisted.parent.id, persisted.input),
            ).toEqual(persisted.receipt);
            expect(
              (yield* settled(chats, persisted.parent.id, "frozen-synthesis"))
                .task,
            ).toBe(persisted.task);
            expect(reopened.faux.state.callCount).toBe(0);
          }).pipe(Effect.provide(reopened.layer));
        }),
      ),
  );

  it.effect("rejects invisible boundaries and duplicate task context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* database;
        const setup = fixture(path, () => fauxAssistantMessage("Seed answer"));
        yield* Effect.gen(function* () {
          const chats = yield* Chats;
          const parent = yield* chats.create(modelA);
          const outsider = yield* chats.create(modelA);
          yield* chats.send(parent.id, {
            text: "Already asked",
            requestId: "already-asked",
          });

          const seed = yield* snapshot(
            chats,
            parent.id,
            (value) => !value.busy && value.messages.length === 2,
          );

          const input: LaunchGroup = {
            task: "Already asked",
            mode: "fork",
            sourceEntry: seed.entries?.at(-1)?.id ?? null,
            models: [modelA],
            requestId: "duplicate-task",
          };

          expect(
            yield* chats.launch(parent.id, input).pipe(Effect.flip),
          ).toMatchObject({ status: 400 });
          expect(
            yield* chats
              .launch(outsider.id, { ...input, task: "New task" })
              .pipe(Effect.flip),
          ).toMatchObject({ status: 400 });
          expect(setup.faux.state.callCount).toBe(1);
        }).pipe(Effect.provide(setup.layer));
      }),
    ),
  );

  it.effect("rejects conflicting simultaneous launch IDs atomically", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* database;

        const setup = fixture(path, () =>
          fauxAssistantMessage("Only one workload"),
        );

        yield* Effect.gen(function* () {
          const chats = yield* Chats;
          const parent = yield* chats.create(modelA);

          const results = yield* Effect.all(
            ["First task", "Different competing task"].map((task) =>
              chats
                .launch(parent.id, {
                  task,
                  mode: "fresh",
                  sourceEntry: null,
                  models: [modelA],
                  requestId: "simultaneous-launch",
                })
                .pipe(Effect.result),
            ),
            { concurrency: "unbounded" },
          );

          expect(results.filter(Result.isSuccess)).toHaveLength(1);
          expect(results.find(Result.isFailure)?.failure).toMatchObject({
            status: 409,
          });
          const done = yield* settled(chats, parent.id, "simultaneous-launch");
          expect(done.candidates).toHaveLength(1);
          expect(yield* chats.list()).toHaveLength(2);
          expect(setup.faux.state.callCount).toBe(1);
        }).pipe(Effect.provide(setup.layer));
      }),
    ),
  );

  for (const activeSibling of [true, false]) {
    it.effect(
      `group stop cancels completed-member continuations and queued inputs (${activeSibling ? "sibling running" : "all initial results settled"})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const path = yield* database;
            const started = yield* Queue.unbounded<string>();
            const stopped = yield* Queue.unbounded<string>();

            const setup = fixture(
              path,
              async (context, options, _state, model) => {
                const user = context.messages.findLast(
                  (item) => item.role === "user",
                );

                const prompt = Predicate.isString(user?.content)
                  ? user.content
                  : JSON.stringify(user?.content);

                const blocked =
                  model.id === "faux-b" && activeSibling
                    ? "sibling"
                    : prompt.includes("Continue completed A")
                      ? "continuation"
                      : null;

                if (!blocked) return fauxAssistantMessage("Completed A result");
                await Effect.runPromise(Queue.offer(started, blocked));
                await new Promise<void>((resolve) => {
                  if (options?.signal?.aborted) resolve();
                  else
                    options?.signal?.addEventListener(
                      "abort",
                      () => resolve(),
                      { once: true },
                    );
                });
                await Effect.runPromise(Queue.offer(stopped, blocked));

                return fauxAssistantMessage("", { stopReason: "aborted" });
              },
            );

            yield* Effect.gen(function* () {
              const chats = yield* Chats;
              const parent = yield* chats.create(modelA);

              const group = yield* chats.launch(parent.id, {
                task: "Run two contestants",
                mode: "fresh",
                sourceEntry: null,
                models: [modelA, modelB],
                requestId: "continuation-stop-group",
              });

              const ready = yield* snapshot(
                chats,
                parent.id,
                (value) =>
                  value.groups?.[0]?.candidates[0]?.status === "completed" &&
                  value.groups?.[0]?.candidates[1]?.status ===
                    (activeSibling ? "running" : "completed"),
              );

              const childId = ready.groups?.[0]?.candidates[0]?.conversationId;

              if (!childId) throw new Error("Missing completed child");
              yield* chats.send(childId, {
                text: "Continue completed A",
                requestId: "running-continuation",
              });

              const labels = activeSibling
                ? ["sibling", "continuation"]
                : ["continuation"];

              expect(
                (yield* Effect.all(
                  labels.map(() => Queue.take(started)),
                )).sort(),
              ).toEqual([...labels].sort());
              yield* chats.send(childId, {
                text: "QUEUED_CHILD_INPUT",
                requestId: "queued-child-input",
              });

              const cancel = action(
                group,
                "cancel",
                0,
                "cancel-current-members",
              );

              yield* chats.groupAction(parent.id, cancel);
              expect(
                (yield* Effect.all(
                  labels.map(() => Queue.take(stopped)),
                )).sort(),
              ).toEqual([...labels].sort());
              const done = yield* settled(chats, parent.id, group.id);
              expect(done.candidates.map((item) => item.status)).toEqual([
                "completed",
                activeSibling ? "cancelled" : "completed",
              ]);
              expect(done.candidates[0]?.answer).toBe("Completed A result");

              const child = yield* snapshot(
                chats,
                childId,
                (value) => !value.busy && value.queued === 0,
              );

              expect(
                child.messages.some(
                  (item) => item.text === "QUEUED_CHILD_INPUT",
                ),
              ).toBe(false);
              expect(setup.faux.state.callCount).toBe(3);
              yield* chats.send(childId, {
                text: "New work after stop",
                requestId: "after-group-stop",
              });
              yield* snapshot(
                chats,
                childId,
                (value) =>
                  !value.busy &&
                  value.messages.some(
                    (item) => item.text === "New work after stop",
                  ),
              );
              yield* chats.groupAction(parent.id, cancel);
              expect(setup.faux.state.callCount).toBe(4);
            }).pipe(Effect.provide(setup.layer));
          }),
        ),
    );
  }

  it.effect(
    "cancels one child without its siblings, then durably cancels the group",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* database;
          const started = yield* Queue.unbounded<void>();
          const stopped = yield* Queue.unbounded<void>();

          const setup = fixture(path, async (_context, options) => {
            await Effect.runPromise(Queue.offer(started, undefined));
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) resolve();
              else
                options?.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            await Effect.runPromise(Queue.offer(stopped, undefined));

            return fauxAssistantMessage("", { stopReason: "aborted" });
          });

          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            const parent = yield* chats.create(modelA);

            const group = yield* chats.launch(parent.id, {
              task: "Wait until cancelled",
              mode: "fresh",
              sourceEntry: null,
              models: [modelA, modelA, modelA],
              requestId: "cancel-arena",
            });

            for (let slot = 0; slot < 3; slot++) yield* Queue.take(started);
            yield* chats.groupAction(parent.id, action(group, "stop", 1));
            yield* Queue.take(stopped);

            const single = yield* snapshot(
              chats,
              parent.id,
              (value) =>
                value.groups?.[0]?.candidates[1]?.status === "cancelled",
            );

            expect(
              single.groups?.[0]?.candidates.map((item) => item.status),
            ).toEqual(["running", "cancelled", "running"]);
            yield* chats.groupAction(parent.id, action(group, "cancel"));
            yield* Queue.take(stopped);
            yield* Queue.take(stopped);
            expect(
              (yield* settled(chats, parent.id, group.id)).candidates.map(
                (item) => item.status,
              ),
            ).toEqual(["cancelled", "cancelled", "cancelled"]);
          }).pipe(Effect.provide(setup.layer));
        }),
      ),
  );

  it.effect(
    "recovers an in-flight generation with stable children, session, cutoff and submission",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* database;
          const started = yield* Deferred.make<void>();
          const requests: string[] = [];
          const sessions: string[] = [];

          const first = fixture(path, async (context, options) => {
            requests.push(JSON.stringify(context.messages));
            sessions.push(options?.sessionId ?? "");
            await Effect.runPromise(Deferred.succeed(started, undefined));
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) resolve();
              else
                options?.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });

            return fauxAssistantMessage("", { stopReason: "aborted" });
          });

          const persisted = yield* Effect.scoped(
            Effect.gen(function* () {
              const chats = yield* Chats;
              const parent = yield* chats.create(modelA);

              const group = yield* chats.launch(parent.id, {
                task: "Recover this exact task",
                mode: "fresh",
                sourceEntry: null,
                models: [modelA],
                requestId: "recover-arena",
              });

              yield* Deferred.await(started);

              return { parent, group };
            }).pipe(Effect.provide(first.layer)),
          );

          const reopened = fixture(path, (context, options) => {
            requests.push(JSON.stringify(context.messages));
            sessions.push(options?.sessionId ?? "");

            return fauxAssistantMessage("Recovered answer");
          });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const chats = yield* Chats;

              const done = yield* settled(
                chats,
                persisted.parent.id,
                persisted.group.id,
              );

              expect(done.candidates[0]?.conversationId).toBe(
                persisted.group.candidates[0]?.conversationId,
              );
              expect(done.coordinatorId).toBe(persisted.group.coordinatorId);
              expect(done.candidates[0]?.answer).toBe("Recovered answer");
              expect(requests).toHaveLength(2);
              expect(requests[0]).toBe(requests[1]);
              expect(sessions[0]).toBe(sessions[1]);
              const child = done.candidates[0];

              if (!child) throw new Error("Missing child");

              const chat = yield* snapshot(
                chats,
                child.conversationId,
                () => true,
              );

              expect(
                chat.messages.filter((item) => item.role === "user"),
              ).toHaveLength(1);
              const audit = yield* chats.audit(child.conversationId);
              expect(audit.requests).toHaveLength(2);
              expect(audit.requests[0]?.requestHash).toBe(
                audit.requests[1]?.requestHash,
              );
              expect(audit.requests[0]?.usage).toBeNull();
              expect(audit.requests[1]?.usage?.cacheRead).toBe(0);
              yield* chats.groupAction(
                persisted.parent.id,
                action(done, "retry"),
              );
              const retry = yield* settled(chats, persisted.parent.id, done.id);
              const replacement = retry.candidates[0];

              if (!replacement) throw new Error("Missing retry");
              const retryAudit = yield* chats.audit(replacement.conversationId);
              expect(retryAudit.requests).toHaveLength(1);
              expect(retryAudit.requests[0]?.sessionHash).not.toBe(
                audit.requests[1]?.sessionHash,
              );
              expect(
                retryAudit.requests[0]?.messages.some(
                  (item) => item.role === "assistant",
                ),
              ).toBe(false);
            }).pipe(Effect.provide(reopened.layer)),
          );
        }),
      ),
  );
});
