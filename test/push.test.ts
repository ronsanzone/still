import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Layer,
  Result,
  Schema,
} from "effect";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Notifier,
  PushFailure,
  notificationExtension,
  subscribe,
  unsubscribe,
  webPushLayer,
} from "../src/kernel/push.ts";
import {
  PushSubscription,
  allowedPushEndpoint,
  type PushEvent,
} from "../src/shared/push.ts";

const subscription = {
  endpoint: "https://web.push.apple.com/test",
  keys: { p256dh: `BA${"a".repeat(84)}A`, auth: "A".repeat(22) },
};

describe("push foundations", () => {
  it("keeps the real adapter disabled without private configuration", async () => {
    let calls = 0;

    const layer = webPushLayer({
      sendNotification: async () => {
        calls += 1;

        return {};
      },
    }).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const notifier = yield* Notifier;

        return yield* Effect.result(
          notifier.send(subscription, {
            eventId: "disabled",
            conversationId: 1,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result))
      expect(result.failure.message).toBe("Push is disabled");
    expect(calls).toBe(0);
  });

  it("rejects arbitrary/private endpoints and malformed keys", () => {
    for (const endpoint of [
      "http://web.push.apple.com/x",
      "https://127.0.0.1/x",
      "https://web.push.apple.com.evil/x",
      "https://user@web.push.apple.com/x",
      "https://web.push.apple.com:444/x",
    ])
      expect(allowedPushEndpoint(endpoint)).toBe(false);
    expect(allowedPushEndpoint(subscription.endpoint)).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(PushSubscription)({
        ...subscription,
        keys: { auth: "bad", p256dh: "bad" },
      }),
    ).toThrow();
  });

  it("uses native receipts across concurrency/restart; failures stay terminal and payload is content-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "still-push-"));
    const sent: PushEvent[] = [];
    let fail = false;
    let pause = false;
    const started = await Effect.runPromise(Deferred.make<void>());

    const push = notificationExtension(
      Notifier.of({
        send: (_subscription, event) =>
          pause
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
              )
            : fail
              ? Effect.fail(new PushFailure({ message: "fake failure" }))
              : Effect.sync(() => {
                  sent.push(event);
                }),
      }),
    );

    const open = async () => {
      const registry = createRegistry();
      registry.install(push.extension);

      return Harness.open(
        await openNodeSqliteStorage(join(directory, "push.sqlite")),
        { models: createModels(), registry },
        context,
      );
    };

    let harness = await open();

    try {
      const conversation = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );

      await conversation.commit(
        (tx) => Effect.runPromise(subscribe(tx, subscription, 1)),
        context,
      );

      const event = {
        eventId: "ready-1",
        conversationId: conversation.id,
        title: "SECRET",
        transcript: "SECRET",
      };

      const ids = await Promise.all(
        Array.from({ length: 8 }, () =>
          conversation.commit(
            (tx) => Effect.runPromise(push.admit(tx, event)),
            context,
          ),
        ),
      );

      expect(new Set(ids).size).toBe(1);
      const first = ids[0];

      if (!first) throw new Error("Missing task");
      expect(
        (await harness.waitForTask(first, context)).state.outcome?.status,
      ).toBe("completed");
      expect(sent).toEqual([
        { eventId: "ready-1", conversationId: conversation.id },
      ]);
      await harness.close(context);
      harness = await open();
      const reopened = await harness.conversation(conversation.id, context);

      if (!reopened) throw new Error("Missing conversation");

      const same = await reopened.commit(
        (tx) => Effect.runPromise(push.admit(tx, event)),
        context,
      );

      expect(same).toBe(ids[0]);
      expect(
        (await harness.waitForTask(same, context)).state.outcome?.status,
      ).toBe("completed");
      expect(sent).toHaveLength(1);
      fail = true;

      const failed = await reopened.commit(
        (tx) =>
          Effect.runPromise(
            push.admit(tx, {
              eventId: "failed",
              conversationId: conversation.id,
            }),
          ),
        context,
      );

      expect(
        (await harness.waitForTask(failed, context)).state.outcome?.status,
      ).toBe("failed");
      fail = false;
      pause = true;

      const recovering = await reopened.commit(
        (tx) =>
          Effect.runPromise(
            push.admit(tx, {
              eventId: "recover",
              conversationId: conversation.id,
            }),
          ),
        context,
      );

      await Effect.runPromise(Deferred.await(started));
      await harness.close(context);
      pause = false;
      harness = await open();
      expect(
        (await harness.waitForTask(recovering, context)).state.outcome?.status,
      ).toBe("completed");
      expect(sent).toHaveLength(2);

      const recoveredConversation = await harness.conversation(
        conversation.id,
        context,
      );

      if (!recoveredConversation)
        throw new Error("Missing recovered conversation");

      const failedReplay = await recoveredConversation.commit(
        (tx) =>
          Effect.runPromise(
            push.admit(tx, {
              eventId: "failed",
              conversationId: conversation.id,
            }),
          ),
        context,
      );

      expect(failedReplay).toBe(failed);
      expect(
        (await harness.waitForTask(failedReplay, context)).state.outcome
          ?.status,
      ).toBe("failed");
      await recoveredConversation.commit(
        (tx) => Effect.runPromise(unsubscribe(tx, subscription.endpoint)),
        context,
      );
      fail = false;

      const revoked = await recoveredConversation.commit(
        (tx) =>
          Effect.runPromise(
            push.admit(tx, {
              eventId: "revoked",
              conversationId: conversation.id,
            }),
          ),
        context,
      );

      expect(
        (await harness.waitForTask(revoked, context)).state.outcome?.status,
      ).toBe("completed");
      expect(sent).toHaveLength(2);
    } finally {
      await harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
