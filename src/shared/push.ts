import { Schema } from "effect";

export const PushSubscription = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  keys: Schema.Struct({
    p256dh: Schema.String.check(
      Schema.isPattern(/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/),
    ),
    auth: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{21}[AQgw]$/)),
  }),
});

export interface PushSubscription extends Schema.Schema.Type<
  typeof PushSubscription
> {}

export const PushEvent = Schema.Struct({
  eventId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  conversationId: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
});

export interface PushEvent extends Schema.Schema.Type<typeof PushEvent> {}

// Exact hostnames only: no suffix matching, caller-supplied hosts or redirects.
export function allowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      [
        "web.push.apple.com",
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
      ].includes(url.hostname) &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}
