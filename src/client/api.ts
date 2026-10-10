import { Effect, Schema } from "effect";
import {
  ApiProblem,
  type GroupAction,
  type LaunchGroup,
  type SendMessage,
} from "../shared/contracts.ts";
import type { BuilderStart, VersionAction } from "../shared/builder.ts";

export function apiPath(path: string) {
  const preview = /^\/builder-preview\/[a-f0-9]{64}/.exec(location.pathname);

  return preview ? `${preview[0]}${path}` : path;
}

export class RequestFailure extends Schema.TaggedError<RequestFailure>()(
  "RequestFailure",
  {
    message: Schema.String,
    status: Schema.Number,
  },
) {}

export const request = Effect.fn("Api.request")(function* <A>(
  path: string,
  schema: Schema.Codec<A>,
  payload?:
    | SendMessage
    | LaunchGroup
    | GroupAction
    | BuilderStart
    | VersionAction
    | { readonly candidate: string }
    | { readonly model: string }
    | Record<string, never>,
  ownerToken?: string,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(
        apiPath(path),
        payload
          ? {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-still-owner": ownerToken ?? "",
              },
              body: JSON.stringify(payload),
              signal,
            }
          : { signal, headers: { "x-still-owner": ownerToken ?? "" } },
      ),
    catch: () =>
      new RequestFailure({
        message:
          "Connection lost. Your draft is safe. Try again when you’re back online.",
        status: 0,
      }),
  });

  const data = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () =>
      new RequestFailure({
        message:
          "The server returned an unreadable response. Please reconnect.",
        status: 0,
      }),
  });

  if (!response.ok) {
    const problem = yield* Schema.decodeUnknownEffect(ApiProblem)(data);

    return yield* new RequestFailure({
      message: problem.message,
      status: response.status,
    });
  }

  return yield* Schema.decodeUnknownEffect(schema)(data);
});
