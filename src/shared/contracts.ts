import { Schema } from "effect";
import { AttachmentUpload, AttachmentMetadata } from "./attachments.ts";
import { Citation } from "./research.ts";

export const ChatId = Schema.Int.check(Schema.isGreaterThan(0));

export const Prompt = Schema.String.check(
  Schema.isPattern(/\S/),
  Schema.isMaxLength(16000),
);

export const ModelChoice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
});

export interface ModelChoice extends Schema.Schema.Type<typeof ModelChoice> {}

export const CreateChat = Schema.Struct({ model: Schema.NonEmptyString });

export const SendMessage = Schema.Struct({
  text: Prompt,
  requestId: Schema.String.check(Schema.isPattern(/^[\w-]{8,80}$/)),
  model: Schema.optionalKey(Schema.NonEmptyString),
  whenBusy: Schema.optionalKey(Schema.Literals(["steer", "followUp"])),
  attachments: Schema.optionalKey(Schema.Array(AttachmentUpload)),
  reuseEntry: Schema.optionalKey(Schema.NullOr(ChatId)),
});

export interface SendMessage extends Schema.Schema.Type<typeof SendMessage> {}

export const Branch = Schema.Struct({
  entry: ChatId,
  model: Schema.NonEmptyString,
});

export interface Branch extends Schema.Schema.Type<typeof Branch> {}

export const Message = Schema.Struct({
  id: Schema.String,
  entry: Schema.NullOr(ChatId),
  before: Schema.NullOr(ChatId),
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  thinking: Schema.String,
  interrupted: Schema.Boolean,
  failed: Schema.Boolean,
  model: Schema.optionalKey(Schema.String),
  cost: Schema.optionalKey(Schema.Number),
  images: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ mimeType: Schema.String, data: Schema.String }),
    ),
  ),
  attachmentText: Schema.optionalKey(Schema.String),
});

export interface Message extends Schema.Schema.Type<typeof Message> {}

export const ChatSummary = Schema.Struct({
  id: ChatId,
  title: Schema.String,
  model: Schema.String,
});

export interface ChatSummary extends Schema.Schema.Type<typeof ChatSummary> {}

export const ChatSnapshot = Schema.Struct({
  ...ChatSummary.fields,
  messages: Schema.Array(Message),
  busy: Schema.Boolean,
  queued: Schema.Number,
  attachments: Schema.Array(AttachmentMetadata),
  citations: Schema.Array(Citation),
  cost: Schema.Number,
  parent: Schema.optionalKey(ChatId),
  changes: Schema.Array(Schema.Struct({ id: ChatId, text: Schema.String })),
  tools: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      text: Schema.String,
      failed: Schema.Boolean,
    }),
  ),
});

export interface ChatSnapshot extends Schema.Schema.Type<typeof ChatSnapshot> {}

export const Work = Schema.Array(
  Schema.Struct({
    id: ChatId,
    conversationId: ChatId,
    kind: Schema.String,
    status: Schema.String,
    background: Schema.Boolean,
  }),
);

export const Bootstrap = Schema.Struct({
  models: Schema.Array(ModelChoice),
  chats: Schema.Array(ChatSummary),
});

export const Receipt = Schema.Struct({ id: Schema.Number });

export const ApiProblem = Schema.Struct({ message: Schema.String });
