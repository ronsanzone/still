import { Schema } from "effect";

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
});

export interface SendMessage extends Schema.Schema.Type<typeof SendMessage> {}

export const Message = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  thinking: Schema.String,
  interrupted: Schema.Boolean,
  failed: Schema.Boolean,
  groupId: Schema.optionalKey(Schema.String),
});

export interface Message extends Schema.Schema.Type<typeof Message> {}

export const ChatSummary = Schema.Struct({
  id: ChatId,
  title: Schema.String,
  model: Schema.String,
});

export interface ChatSummary extends Schema.Schema.Type<typeof ChatSummary> {}

export const LaunchGroup = Schema.Struct({
  task: Prompt,
  mode: Schema.Literals(["fresh", "fork"]),
  sourceEntry: Schema.NullOr(ChatId),
  models: Schema.Array(Schema.NonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  requestId: SendMessage.fields.requestId,
});

export interface LaunchGroup extends Schema.Schema.Type<typeof LaunchGroup> {}

export const Candidate = Schema.Struct({
  slot: Schema.Number,
  conversationId: ChatId,
  model: Schema.String,
  attempt: Schema.Number,
  status: Schema.Literals([
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]),
  answer: Schema.String,
  error: Schema.String,
});

export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}

export const Group = Schema.Struct({
  id: Schema.String,
  task: Schema.String,
  mode: LaunchGroup.fields.mode,
  sourceEntry: LaunchGroup.fields.sourceEntry,
  coordinatorId: ChatId,
  cancelled: Schema.Boolean,
  candidates: Schema.Array(Candidate),
});

export interface Group extends Schema.Schema.Type<typeof Group> {}

export const GroupAction = Schema.Struct({
  groupId: Schema.NonEmptyString,
  action: Schema.Literals(["cancel", "stop", "retry", "return", "synthesize"]),
  slot: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThan(5),
  ),
  requestId: SendMessage.fields.requestId,
  model: Schema.optionalKey(Schema.NonEmptyString),
});

export interface GroupAction extends Schema.Schema.Type<typeof GroupAction> {}

export const ChatSnapshot = Schema.Struct({
  ...ChatSummary.fields,
  messages: Schema.Array(Message),
  busy: Schema.Boolean,
  queued: Schema.Number,
  groups: Schema.optionalKey(Schema.Array(Group)),
  entries: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: ChatId, label: Schema.String })),
  ),
  parent: Schema.optionalKey(ChatId),
  builder: Schema.optionalKey(Schema.String),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        text: Schema.String,
        failed: Schema.Boolean,
      }),
    ),
  ),
});

export interface ChatSnapshot extends Schema.Schema.Type<typeof ChatSnapshot> {}

export const Bootstrap = Schema.Struct({
  models: Schema.Array(ModelChoice),
  chats: Schema.Array(ChatSummary),
});

export const Receipt = Schema.Struct({ id: Schema.Number });

export const ApiProblem = Schema.Struct({ message: Schema.String });
