import { Schema } from "effect";

export const Citation = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  fetchedAt: Schema.String,
});

export interface Citation extends Schema.Schema.Type<typeof Citation> {}

export const ResearchDetails = Schema.Struct({
  source: Schema.Literal("still.research"),
  citations: Schema.Array(Citation),
  urls: Schema.Array(Schema.String),
  confirmation: Schema.optionalKey(Schema.String),
});

export const FetchDecision = Schema.Struct({
  url: Schema.String,
  allow: Schema.Boolean,
  requestId: Schema.String.check(Schema.isPattern(/^[\w-]{8,80}$/)),
});

export interface FetchDecision extends Schema.Schema.Type<
  typeof FetchDecision
> {}
