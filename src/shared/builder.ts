import { Schema } from "effect";
import { CreateChat, SendMessage } from "./contracts.ts";

export const VersionId = Schema.String.check(Schema.isPattern(/^[\w-]{8,80}$/));

export const BuilderStart = Schema.Struct({
  ...SendMessage.fields,
  ...CreateChat.fields,
});

export interface BuilderStart extends Schema.Schema.Type<typeof BuilderStart> {}

export const BuilderAdmission = Schema.Struct({
  ...BuilderStart.fields,
  candidate: VersionId,
});

export interface BuilderAdmission extends Schema.Schema.Type<
  typeof BuilderAdmission
> {}

export const VersionAction = Schema.Struct({
  candidate: VersionId,
  version: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export interface VersionAction extends Schema.Schema.Type<
  typeof VersionAction
> {}

export const CandidateVersion = Schema.Struct({
  id: VersionId,
  base: Schema.String,
  version: Schema.String,
  status: Schema.Literals(["editing", "validated", "activated", "failed"]),
  diff: Schema.String,
  checks: Schema.String,
  preview: Schema.NullOr(Schema.String),
});

export interface CandidateVersion extends Schema.Schema.Type<
  typeof CandidateVersion
> {}

export const BuilderStatus = Schema.Struct({
  active: Schema.String,
  previous: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(Schema.String),
  outcome: Schema.String,
  candidates: Schema.Array(CandidateVersion),
});

export interface BuilderStatus extends Schema.Schema.Type<
  typeof BuilderStatus
> {}

export const Readiness = Schema.Struct({
  status: Schema.Literal("ready"),
  release: Schema.String,
  extensions: Schema.Array(Schema.String),
});
