# Web Push setup

Settings exposes enable/disable notifications and a test event for the open conversation.
The real transport is disabled until operator VAPID configuration is supplied.
Automatic notifications (for example when a subagent batch settles) arrive with the subagents phase.
Push is a hint to fetch Pi's authoritative state, never a report store.

## Wiring

- `src/server/services.ts` resolves `Notifier` from `webPushLayer(webPush)`; Chats installs `notificationExtension(notifier)` before opening the Harness, including recovery.
- Decode unknown HTTP inputs with the exported `PushSubscription` / `PushEvent` schemas first. Within a Pi Session/conversation `commit`, await `Effect.runPromise(subscribe(tx, decodedInput, Date.now()))`, `unsubscribe(tx, endpoint)`, or `push.admit(tx, { eventId, conversationId })`. These promise bridges are framework boundaries; do not run effects after the transaction returns.
- Admission returns a native task ID. Use `harness.waitForTask` to inspect terminal outcomes. Event IDs are session-wide immutable identities; conflicting conversation IDs are rejected. Allocate stable opaque IDs, not titles, prompts, user names or other content.
- The app has no login; it relies on a loopback bind plus Tailscale. Mutation routes require JSON and `X-Still-Client: 1` and reject cross-site requests; this CSRF boundary is not owner authentication. Subscription endpoints and keys are private capabilities; never return the session document publicly or log it. Native subscriptions support endpoint-key replacement and explicit revocation.
- The enable button registers `/sw.js` at root scope. Use HTTPS; on iPhone, install the app to the Home Screen first. Click navigation uses `/?chat=<numeric ID>`. Disable revokes the server subscription before unsubscribing locally. Expiry cleanup is manual.

## Private operator configuration (no account or privileged operations)

The pinned `web-push` dependency uses ordinary HTTPS requests and does **not** follow HTTP redirects. Do not substitute a redirect-following client.

On the trusted deployment host, the operator can run this from the installed checkout. It writes a new private file and refuses to overwrite an existing key pair; it prints no secret values. **This command was not run as part of this milestone.**

```sh
node --input-type=module <<'NODE'
import webPush from 'web-push';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const directory = join(homedir(), '.config', 'still');
await mkdir(directory, { recursive: true, mode: 0o700 });
const keys = webPush.generateVAPIDKeys();
await writeFile(join(directory, 'web-push.env'),
  `STILL_VAPID_PUBLIC_KEY=${keys.publicKey}\nSTILL_VAPID_PRIVATE_KEY=${keys.privateKey}\nSTILL_VAPID_SUBJECT=mailto:REPLACE_WITH_OPERATOR_CONTACT\n`,
  { flag: 'wx', mode: 0o600 });
NODE
```

Edit the contact in that private file with a local editor. Keep it outside repository artifacts and publishable backups. Do not paste private values into chat or shell command arguments. Supply these server-only variables to the app's process environment; final Mac launchd/private-environment provisioning is still an operator/deployment gate, not an implemented installer:

```
STILL_VAPID_PUBLIC_KEY=<generated public key>
STILL_VAPID_PRIVATE_KEY=<generated private key>
STILL_VAPID_SUBJECT=mailto:<operator contact>
```

`GET /api/push` exposes only the public key as the browser's `applicationServerKey`. Missing any variable disables sending with a recorded failed task; no fallback credentials exist. The UI reports admission, not delivery status; a persistent delivery-status view is not implemented. Restart the service after configuration changes. Keep the same key pair across restarts; rotation requires browser resubscription. Do not commit credential files. No accounts, privileged installer steps, live test calls or paid services were performed here.

## Endpoint policy and limits

Only exact HTTPS hosts `web.push.apple.com`, `fcm.googleapis.com`, and `updates.push.services.mozilla.com` are accepted; credentials, nondefault ports and fragments are rejected. This deliberately excludes other providers (including Windows push) rather than accepting arbitrary URLs or suffix matches. Trusted provider DNS and deployment egress are part of the boundary: enforce private-network egress denial at deployment for defense in depth. No caller-controlled host is contacted. Subscription keys must have Web Push base64url lengths and an uncompressed P-256 prefix; the SDK validates curve/key cryptography. Expired subscriptions are not automatically deleted; unsubscribe/resubscribe explicitly. Requests have a 10-second timeout and 300-second TTL; there is no automatic failure retry.

Native `still.push` stores session subscriptions. Native `still.push-event` family documents retain admission receipts; native `still.push-notification` tasks snapshot recipients and checkpoint after each successful send. Completed and failed tasks do not replay after restart. Receipts and browser dedupe IDs currently persist indefinitely; do not prune them without defining an idempotency retention window.

Exactly-once provider delivery is impossible: a crash after provider acceptance but before the checkpoint may resend. A provider timeout may also represent accepted delivery. Recovery retries only the uncheckpointed recipient; no inference or transcript write occurs. Native terminal failures remain recorded and are not silently retried; an intentional retry needs a new event ID and can duplicate an earlier accepted request. Revocation cannot cancel in-flight delivery. A failed recipient ends the task, so later recipients are not attempted.

Payload is exactly `{eventId, conversationId}`. Notification title/body are fixed, with stable `still-<eventId>` tags and IndexedDB event dedupe across service-worker restarts. Notification display and IndexedDB writes are not atomic: crashes can produce another display or platform suppression. Browser clearing storage removes dedupe. This is best-effort client dedupe, not an exactly-once claim. Real iPhone installed-PWA delivery, lock-screen behavior and permission handling remain unverified; no live requests were made.
