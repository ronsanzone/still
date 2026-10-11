import { Schema } from "effect";

export const AttachmentMime = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

export const AttachmentUpload = Schema.Struct({
  name: Schema.NonEmptyString,
  mimeType: AttachmentMime,
  data: Schema.String.check(
    Schema.isPattern(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    ),
  ),
});

export interface AttachmentUpload extends Schema.Schema.Type<
  typeof AttachmentUpload
> {}

export const AttachmentMetadata = Schema.Struct({
  name: Schema.String,
  mimeType: AttachmentMime,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export interface AttachmentMetadata extends Schema.Schema.Type<
  typeof AttachmentMetadata
> {}

/** An adaptive Markdown fence: no line of the payload can close it. */
export function fenceAttachment(text: string): string {
  const runs = text.match(/`+/g) ?? [];

  const length = runs.reduce(
    (longest, run) => Math.max(longest, run.length + 1),
    3,
  );

  const fence = "`".repeat(length);

  return `<untrusted>\n${fence}untrusted-attachment\n${text.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n${fence}\n</untrusted>`;
}
