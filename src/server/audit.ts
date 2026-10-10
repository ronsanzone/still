import { createHash } from "node:crypto";
import type { JsonRepresentation } from "@earendil-works/chord";
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
  type Harness,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

export const RequestAudit = Schema.Struct({
  taskId: Schema.Number,
  model: Schema.String,
  sessionHash: Schema.String,
  requestHash: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      hash: Schema.String,
      characters: Schema.Number,
    }),
  ),
  usage: Schema.NullOr(
    Schema.Struct({
      input: Schema.Number,
      output: Schema.Number,
      cacheRead: Schema.Number,
      cacheWrite: Schema.Number,
    }),
  ),
});

export interface RequestAudit extends Schema.Schema.Type<typeof RequestAudit> {}

export const Audit = Schema.Struct({
  requests: Schema.Array(RequestAudit),
  cacheEvidence: Schema.String,
});

export interface Audit extends Schema.Schema.Type<typeof Audit> {}

export const AuditDoc = defineDoc<{
  requests: JsonRepresentation<RequestAudit>[];
}>({
  kind: "still.request-audit",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: [] }),
});

export function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

// Audit the final logical messages at Durable's request hook, without storing prompt text or credentials.
// Provider adapters can transform these messages; this is not a wire capture or a KV-cache claim.
export function auditExtension(getHarness: () => Harness) {
  return defineExtension({
    name: "still.request-audit",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          await getHarness().commit(async (tx) => {
            const agent = await tx.doc(AgentDoc, api.conversationId);
            const provider = await tx.doc(ProviderDoc, api.conversationId);
            const audit = await tx.doc(AuditDoc, api.conversationId);
            audit.requests.push({
              taskId: api.taskId,
              model: agent.model
                ? `${agent.model.provider}/${agent.model.modelId}`
                : "",
              sessionHash: digest(provider.sessionId),
              requestHash: digest(JSON.stringify(request.messages)),
              messages: request.messages.map((message) => ({
                role: message.role,
                hash: digest(JSON.stringify(message)),
                characters: JSON.stringify(message.content).length,
              })),
              usage: null,
            });
          }, context);
        },
        afterResponse: async (message, api, context) => {
          await getHarness().commit(async (tx) => {
            const audit = await tx.doc(AuditDoc, api.conversationId);

            const request = audit.requests.findLast(
              (item) => item.taskId === api.taskId && item.usage === null,
            );

            if (request)
              request.usage = {
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                cacheWrite: message.usage.cacheWrite,
              };
          }, context);
        },
      }),
    ],
  });
}
