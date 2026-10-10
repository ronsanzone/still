import {
  ConfigProvider,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
} from "effect";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Chats } from "../../src/server/chat.ts";
import { ModelCatalog } from "../../src/server/models.ts";
import { digest } from "../../src/server/audit.ts";

const initialized = await Effect.runPromise(Deferred.make<void>());

let parentId = 0;

let childId = 0;

const faux = fauxProvider({ tokensPerSecond: 0, models: [{ id: "faux-a" }] });

faux.setResponses([
  async (context, options) => {
    await Effect.runPromise(Deferred.await(initialized));
    process.send?.({
      parentId,
      childId,
      sessionHash: digest(options?.sessionId ?? ""),
      requestHash: digest(JSON.stringify(context.messages)),
    });

    // The test kills this process with SIGKILL while the provider request is unresolved.
    return await new Promise<never>(() => {});
  },
]);

const models = createModels();

models.setProvider(faux.provider);

const catalog = Layer.succeed(
  ModelCatalog,
  ModelCatalog.of({
    runtime: models,
    choices: [{ id: "faux/faux-a", name: "Faux A", provider: "faux" }],
  }),
);

const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ STILL_DATABASE: process.argv[2] }),
);

const runtime = ManagedRuntime.make(
  Chats.layer.pipe(Layer.provide(catalog), Layer.provide(config)),
);

await runtime.runPromise(
  Effect.gen(function* () {
    const chats = yield* Chats;
    const parent = yield* chats.create("faux/faux-a");

    const group = yield* chats.launch(parent.id, {
      task: "Hard crash recovery task",
      mode: "fresh",
      sourceEntry: null,
      models: ["faux/faux-a"],
      requestId: "hard-crash-arena",
    });

    parentId = parent.id;
    childId = group.candidates[0]?.conversationId ?? 0;
    yield* Deferred.succeed(initialized, undefined);
  }),
);

// Keep an IPC listener, not a timer, so the subprocess remains alive at the crash point.
process.on("message", (message) => {
  if (message === "cancel")
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const chats = yield* Chats;
          yield* chats.groupAction(parentId, {
            groupId: "hard-crash-arena",
            action: "cancel",
            slot: 0,
            requestId: "crash-cancel-request",
          });
          process.send?.({ cancelAdmitted: true });
        }),
      )
      .catch(() => process.exit(1));
});
