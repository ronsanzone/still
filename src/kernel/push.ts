import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import {
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  PushEvent,
  PushSubscription,
  allowedPushEndpoint,
} from "../shared/push.ts";

export class PushFailure extends Schema.TaggedError<PushFailure>()(
  "PushFailure",
  {
    message: Schema.String,
  },
) {}

export class Notifier extends Context.Service<
  Notifier,
  {
    readonly send: (
      subscription: PushSubscription,
      event: PushEvent,
    ) => Effect.Effect<void, PushFailure>;
  }
>()("still/Notifier") {}

// SDK boundary supplied by the composition root; no global VAPID mutation.
export interface WebPushTransport {
  sendNotification(
    subscription: PushSubscription,
    payload: string,
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
      TTL: number;
      timeout: number;
    },
  ): Promise<object>;
}

export const webPushLayer = (transport: WebPushTransport) =>
  Layer.effect(
    Notifier,
    Effect.gen(function* () {
      const publicKey = yield* Config.option(
        Config.String("STILL_VAPID_PUBLIC_KEY"),
      );

      const privateKey = yield* Config.option(
        Config.Redacted("STILL_VAPID_PRIVATE_KEY"),
      );

      const subject = yield* Config.option(
        Config.String("STILL_VAPID_SUBJECT"),
      );

      return Notifier.of({
        send: Effect.fn("Notifier.send")(function* (subscription, event) {
          if (
            Option.isNone(publicKey) ||
            Option.isNone(privateKey) ||
            Option.isNone(subject)
          )
            return yield* Effect.fail(
              new PushFailure({ message: "Push is disabled" }),
            );

          if (!allowedPushEndpoint(subscription.endpoint))
            return yield* Effect.fail(
              new PushFailure({ message: "Invalid push endpoint" }),
            );
          // Explicit projection prevents accidental transcript/title leakage.
          yield* Effect.tryPromise({
            try: () =>
              transport.sendNotification(
                subscription,
                JSON.stringify({
                  eventId: event.eventId,
                  conversationId: event.conversationId,
                }),
                {
                  vapidDetails: {
                    subject: subject.value,
                    publicKey: publicKey.value,
                    privateKey: Redacted.value(privateKey.value),
                  },
                  TTL: 300,
                  timeout: 10000,
                },
              ),
            catch: () => new PushFailure({ message: "Push delivery failed" }),
          });
        }),
      });
    }),
  );

type SubscriptionState = {
  subscriptions: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    createdAt: number;
  }[];
};

export const PushDoc = defineDoc({
  kind: "still.push",
  version: 1,
  scope: "session",
  initial: (): SubscriptionState => ({ subscriptions: [] }),
});

// Native family receipts survive completed tasks and make admission atomic.
const EventReceipt = defineDocFamily({
  kind: "still.push-event",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ taskId: 0, conversationId: 0 }),
});

export const subscribe = Effect.fn("Push.subscribe")(function* (
  tx: Tx,
  input: PushSubscription,
  now: number,
) {
  const subscription =
    yield* Schema.decodeUnknownEffect(PushSubscription)(input);

  if (!allowedPushEndpoint(subscription.endpoint))
    return yield* Effect.fail(
      new PushFailure({ message: "Invalid push endpoint" }),
    );
  yield* Effect.promise(async () => {
    const doc = await tx.doc(PushDoc);

    const existing = doc.subscriptions.findIndex(
      (item) => item.endpoint === subscription.endpoint,
    );

    const value = { ...subscription, createdAt: now };

    if (existing >= 0) doc.subscriptions[existing] = value;
    else doc.subscriptions.push(value);
  });
});

export const unsubscribe = Effect.fn("Push.unsubscribe")(function* (
  tx: Tx,
  endpoint: string,
) {
  yield* Effect.promise(async () => {
    const doc = await tx.doc(PushDoc);
    doc.subscriptions = doc.subscriptions.filter(
      (item) => item.endpoint !== endpoint,
    );
  });
});

type Checkpoint =
  | { phase: "snapshot" }
  | { phase: "send"; subscriptions: PushSubscription[]; index: number };

export function notificationExtension(notifier: Notifier["Service"]) {
  const task = defineTask<PushEvent, Checkpoint, null>({
    name: "still.push-notification",
    version: 1,
    initial: () => ({ phase: "snapshot" }),
    phases: {
      snapshot: async (_task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(PushDoc);

          return {
            status: "running",
            checkpoint: {
              phase: "send",
              subscriptions: doc.subscriptions.map(({ endpoint, keys }) => ({
                endpoint,
                keys,
              })),
              index: 0,
            },
          };
        }, context);
      },
      send: async (record, runtime, context) => {
        const checkpoint = record.state.checkpoint;
        const subscription = checkpoint.subscriptions[checkpoint.index];

        if (!subscription) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: null },
            }),
            context,
          );

          return;
        }

        // Revocation is checked immediately before sending, but cannot retract an in-flight request.
        const active = await runtime.snapshot(PushDoc, context);

        if (
          active?.subscriptions.some(
            (item) => item.endpoint === subscription.endpoint,
          )
        ) {
          const result = await Effect.runPromise(
            Effect.result(notifier.send(subscription, record.input)),
            { signal: runtime.signal },
          );

          if (Result.isFailure(result)) {
            await runtime.commit(
              () => ({
                status: "terminal",
                outcome: {
                  status: "failed",
                  error: { message: "Push delivery failed or disabled" },
                },
              }),
              context,
            );

            return;
          }
        }

        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: { ...checkpoint, index: checkpoint.index + 1 },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });

  const extension = defineExtension({ name: "still.push", tasks: [task] });

  const admit = Effect.fn("Push.admit")(function* (tx: Tx, input: PushEvent) {
    const decoded = yield* Schema.decodeUnknownEffect(PushEvent)(input);

    const event = {
      eventId: decoded.eventId,
      conversationId: decoded.conversationId,
    };

    return yield* Effect.promise(async () => {
      const receipt = await tx.doc(EventReceipt, event.eventId, null);

      if (receipt.taskId) {
        if (receipt.conversationId !== event.conversationId)
          throw new PushFailure({ message: "Event identity conflict" });

        // SAFETY: allocated Pi task ID read from its native receipt.
        return receipt.taskId as TaskId<null>;
      }

      // SAFETY: schema-validated numeric ID, existence checked below.
      const conversationId = event.conversationId as ConversationId;

      if (!(await tx.conversation(conversationId)))
        throw new PushFailure({ message: "Conversation not found" });

      const taskId = await tx.createTask(task, event, {
        ownership: { kind: "conversation" },
        conversationId,
        background: true,
      });

      receipt.taskId = taskId;
      receipt.conversationId = conversationId;

      return taskId;
    });
  });

  return { extension, admit };
}
