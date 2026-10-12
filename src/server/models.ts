import { readFile } from "node:fs/promises";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelChoice } from "../shared/contracts.ts";

const DemoStep = Schema.Struct({
  text: Schema.String,
  tool: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly runtime: Models;
    readonly choices: readonly ModelChoice[];
  }
>()("still/ModelCatalog") {
  static readonly layer = Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      // Explicit offline demo, never a fallback for missing/failed paid provider credentials.
      const demo = yield* Config.String("STILL_FAUX_DEMO").pipe(
        Config.withDefault(""),
      );

      if (demo) {
        const steps = yield* Effect.promise(() => readFile(demo, "utf8"));

        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Array(DemoStep)),
        )(steps);

        const { fauxProvider, fauxAssistantMessage, fauxToolCall } =
          yield* Effect.promise(
            () => import("@earendil-works/pi-ai/providers/faux"),
          );

        const faux = fauxProvider({ tokensPerSecond: 0 });
        faux.setResponses(
          decoded.map((step) =>
            step.tool
              ? fauxAssistantMessage(
                  fauxToolCall(step.tool, step.arguments ?? {}),
                  { stopReason: "toolUse" },
                )
              : fauxAssistantMessage(step.text),
          ),
        );
        const runtime = createModels();
        runtime.setProvider(faux.provider);

        return ModelCatalog.of({
          runtime,
          choices: [
            {
              id: "faux/faux-1",
              name: "Scripted faux · offline demo",
              provider: "faux",
            },
          ],
        });
      }

      const go = yield* Config.option(Config.Redacted("OPENCODE_GO_API_KEY"));

      const anthropic = yield* Config.option(
        Config.Redacted("ANTHROPIC_API_KEY"),
      );

      const openai = yield* Config.option(Config.Redacted("OPENAI_API_KEY"));

      const keys = new Map([
        ["OPENCODE_API_KEY", go],
        ["ANTHROPIC_API_KEY", anthropic],
        ["OPENAI_API_KEY", openai],
      ]);

      const runtime = createModels({
        authContext: {
          env: async (name) => {
            const key = keys.get(name);

            return key && Option.isSome(key)
              ? Redacted.value(key.value)
              : undefined;
          },
          fileExists: async () => false,
        },
      });

      if (Option.isSome(go)) runtime.setProvider(opencodeGoProvider());

      if (Option.isSome(anthropic)) runtime.setProvider(anthropicProvider());

      if (Option.isSome(openai)) runtime.setProvider(openaiProvider());

      // Optional comma-separated `provider/model` allowlist, e.g. free models only for testing.
      const allowlist = yield* Config.String("STILL_MODEL_ALLOWLIST").pipe(
        Config.withDefault(""),
      );

      const allowed = new Set(
        allowlist
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      );

      const choices = runtime
        .getModels()
        .map((model) => ({
          id: `${model.provider}/${model.id}`,
          name: model.name,
          provider: model.provider,
        }))
        .filter((choice) => allowed.size === 0 || allowed.has(choice.id));

      choices.sort((a, b) => a.name.localeCompare(b.name));

      return ModelCatalog.of({ runtime, choices });
    }),
  );
}
