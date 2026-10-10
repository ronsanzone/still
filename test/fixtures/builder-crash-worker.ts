import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Chats } from "../../src/server/chat.ts";
import { ModelCatalog } from "../../src/server/models.ts";

const faux = fauxProvider({ tokensPerSecond: 0 });

faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("bash", {
      command:
        "printf '%s\\n' \"$$\" > shell.pid; printf 'once\\n' >> side-effects.txt; sleep 1000",
    }),
    { stopReason: "toolUse" },
  ),
]);

const models = createModels();

models.setProvider(faux.provider);

const catalog = Layer.succeed(
  ModelCatalog,
  ModelCatalog.of({
    runtime: models,
    choices: [{ id: "faux/faux-1", name: "Faux", provider: "faux" }],
  }),
);

const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    STILL_DATABASE: process.argv[2],
    STILL_BUILDER_ROOT: process.argv[3],
  }),
);

const runtime = ManagedRuntime.make(
  Chats.layer.pipe(Layer.provide(catalog), Layer.provide(config)),
);

const result = await runtime.runPromise(
  Effect.gen(function* () {
    const chats = yield* Chats;

    return yield* chats.builder({
      candidate: "crashed-builder-001",
      requestId: "crashed-builder-001",
      model: "faux/faux-1",
      text: "Run the candidate shell side effect",
    });
  }),
);

process.send?.(result);

process.on("message", () => {});
