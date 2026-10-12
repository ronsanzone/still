import { Schema } from "effect";

export const FeedbackInput = Schema.Struct({
  text: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000)),
  /** Stable per submission, so a retried save never duplicates. */
  requestId: Schema.String.check(Schema.isPattern(/^[\w-]{8,80}$/)),
  conversationId: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Where it was written, e.g. "chat · research · longcat · 390x844 standalone". */
  context: Schema.String.check(Schema.isMaxLength(200)),
});

export interface FeedbackInput extends Schema.Schema.Type<
  typeof FeedbackInput
> {}

export const FeedbackItem = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  conversationId: Schema.NullOr(Schema.Number),
  context: Schema.String,
  release: Schema.String,
  createdAt: Schema.Number,
});

export interface FeedbackItem extends Schema.Schema.Type<typeof FeedbackItem> {}

export const FeedbackList = Schema.Array(FeedbackItem);

/** `/feedback <note>` in the composer saves a note instead of asking the model. */
export function parseFeedback(draft: string): string | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/i.exec(draft.trim());

  return match ? (match[1] ?? "").trim() : null;
}
