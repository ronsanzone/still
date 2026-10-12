# Still

An original iPhone-first technical chat app on **Pi Durable 1.0.2** and
**Effect 4.0.0**, inspired by Pi Pocket rather than forked from it.

The authoritative target is [spec v1.2](docs/rearchitecture-and-product-spec.md).
The [baseline design/provenance](docs/rearchitecture-design.md) is historical.
This checkout implements **Phase 1 product core and Phase 2 attachments,
Research and push foundations**, not the entire spec.

## Current product

- Streaming Markdown chat, reconnectable SSE, browser drafts and stable send IDs.
- Explicit model choice on new chats and per turn. Changing models requires idle
  state; it never silently falls back to a different or paid model.
- Chat / Research / Still kit labels backed by one `still.grant {kit,target}`
  document. Chat has no tools; Research has read-only web search and fetch.
  Research cannot combine its tools with Still filesystem/shell authority.
- Image, PDF and UTF-8 text attachments. Images are normalized to at most 1600px;
  PDF text is extracted and originals stored by SHA-256 outside source releases.
  Sources and extracted content remain in Pi's native transcript across reconnect
  and retry/edit branches. PDF download requires visible attachment provenance.
- Numbered fetched/uploaded sources and exact-URL confirmation cards. Model-only
  URLs grant no network authority. Source cards come from tool metadata, not
  model-authored references; they do not prove the model's answer is accurate.
- Optional Web Push subscription/revocation and manual test-event delivery using
  native durable tasks/checkpoints. Automatic batch/release triggers are next-phase
  work. See [operator setup and delivery limits](docs/push-setup.md).
- Still selects Pi's read/write/edit/bash tools only for a supervisor-created
  candidate. The ordinary client cannot grant this authority. Selecting Still
  without that authority returns 403; the final approval UI is not implemented.
- Queue and Steer use Pi's native input modes. Steer is boundary delivery, not
  an immediate interruption or promise of priority over already queued input.
- Edit/resend and retry create a **Chat branch before the selected user prompt**.
  The original transcript remains intact. Retrying does not repeat prior tools.
- Reported per-response and conversation cost from Pi assistant usage/UsageDoc.
  These are provider-adapter estimates, not a billing guarantee. Missing/zero
  reports are not proof of free inference. Catalog-recomputed estimates remain
  future work; the UI deliberately labels current numbers as reported costs.
- Chats and an initial Work projection of Pi's live task graph. Completed tasks
  leave Work; conversations remain. This is not yet a generic-agent report inbox.

Arena, group synthesis/return, Builder sheets/commands and request-audit product
routes have been removed. Generic-agent tools and reports will replace those
product concepts; they are **not implemented in this milestone**. Voice, passkeys,
automatic report notifications and native iOS are also not implemented.

## Run and fresh state

Use Node 26.10.0, `npm ci`, then `npm run dev`. In an Amp orb,
`amp orb services ensure` exposes the supervised development service. The product
runtime itself has no Amp/E2B dependency. `.agents/setup` / `.agents/resume`
prepare this development environment.

Choose a fresh `STILL_DATABASE` (default `.data/still-v1.sqlite`). **There is no
migration.** Stop the old process and archive its SQLite database plus any WAL/SHM
sidecars before cutover. Do not delete or overwrite the archive. Startup refuses
pre-v1 conversation metadata before resuming work. If using the legacy release
supervisor, use a fresh `STILL_HOST_ROOT`; do not activate this baseline over its
old live database. Browser storage uses a new `still:v1` namespace.

Configure server-side `OPENCODE_GO_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY` for real requests. Optional `STILL_MODEL_ALLOWLIST` (comma-separated
`provider/model` IDs) limits both the offered and the accepted models, for
example to confirmed-free models during testing. Credentials are never sent to the browser.
Models can incur charges. Tests and explicit `STILL_FAUX_DEMO` use a scripted
faux provider; credential failure never enables a fallback. Live development
tests require explicit selection of a currently verified free model.

The app binds loopback and assumes a single authenticated owner at the proxy.
It is not a public multi-user service. Never expose it without owner access
control. Browser emulation does not replace real iPhone/Safari validation.

## Research and attachment boundaries

Supply `BRAVE_SEARCH_API_KEY` through the host's private environment mechanism,
then restart. Obtain/enter the credential yourself; nothing provisions a Brave
account. Without it search fails visibly, with no provider fallback. Fetching
explicitly supplied public URLs needs no search credential. Live search pricing
and quotas are operator decisions; verification uses local/fake adapters only.

Each URL, including redirect destinations, must occur in native user input,
successful search/fetch provenance, or an explicit owner confirmation. There is
no wildcard origin grant. DNS answers are checked and the connection is pinned to
the checked address while retaining Host/SNI and TLS verification. Private,
reserved, metadata, tailnet and mapped addresses are denied; redirects recheck
both provenance and DNS. DNS/connect and idle reads time out after 60 seconds.
Readability extracts HTML; pdf.js extracts PDF text. External content and metadata
are fenced as untrusted. Fencing is not a prompt-injection security boundary.

There is no deliberate response-size/text truncation or attachment-count cap.
Large inputs can exhaust process/browser storage or model context and fail;
hostile-file resource containment is not implemented. Pending browser sends use
localStorage and must fit its quota. Extracted PDF text omits scanned-image OCR.
Uploads require an idle chat. Attachment metadata is a passive Pi entry followed
by input admission: a crash between commits can leave metadata without a prompt;
retrying the same ID reuses its source numbers. Originals may remain after failed
admission and have no GC. Default storage is `attachments/` beside `STILL_DATABASE`.

## Authority and persistence

React renders projections; Effect owns configuration, decoded HTTP boundaries,
typed failures, scoped resources and streams. One Chats service owns one Harness
and SQLite file. Pi owns entries, submissions, inbox, live state, task graph,
usage and recovery. There is no second conversation, queue or task store.

`src/kernel/kits.ts` configures tools, extensions, instructions and cwd from the
grant. Its tool hook independently denies ungranted calls; its environment
resolver requires a Still target and matching canonical candidate cwd. A
conversation-created callback resets raw conversations, task-owned children and
forks to Chat with no target, tools or cwd, regardless of parent authority.

Kit changes check **LiveDoc and InboxDoc in the same transaction** as grant,
AgentDoc configuration and a passive kit-change entry. Model changes are likewise
idle-only and recorded. Host send/kit/branch calls are serialized. Pi 1.0.2 has no
public `tx.submit`, so config and submission are **two commits**, not a claimed
atomic combined operation: a crash before submit admits no input and retry uses
the original request ID. Native Pi delivery/idempotency governs admitted input;
this does not promise exactly-once provider billing.

Fork boundaries are inclusive Pi entry IDs. The UI selects the entry *before*
the prompt being edited/retried. Future parent messages and sibling changes do
not enter the branch. No physical KV cache sharing, retention, invalidation or
compaction guarantees are made; the application does not own provider KV memory.

## Retained protected release pipeline — transitional, not a new product UI

`src/host` and the protected `/api/builder/chat` bridge remain to support the Still
kit and exercise existing release guarantees. Candidate creation atomically
creates/configures its Still conversation; submission follows through Pi. The
supervisor's journal owns candidate/release lifecycle, not chat transcripts.

The legacy supervisor uses an owner-token header and internal admission token.
**This is not the proposed ReleaseHost caller split or supervisor-owned passkey
approval. Do not expose it for Mac deployment.** The final approval/caller
protocol is Phase 4 work. The plain chat server cannot create coding candidates.

Current retained guarantees:

1. Positive source allowlist excludes databases, credentials, dependencies and
   runtime artifacts. Never place secrets inside source files.
2. Checks copy candidates to staging, gate those exact bytes, run fixed external
   TypeScript/Oxlint/test/build commands, and compare hashes before/after.
   Kernel, host, deployment, chat/main and dependency changes require maintenance
   outside this pipeline. Migration-named files are rejected, not executed.
3. Checked immutable releases use supervisor ownership. Version-bound previews
   use a separate DB and no configured providers or admission token. Later
   candidate edits cannot enter an approval of an earlier digest.
4. Exact digest approval precedes a durable pending-activation journal write,
   dedicated-account process cleanup and startup/readiness validation. Failed
   startup rolls back code; crash recovery restores the committed version.
5. Trusted `extensions/*.{ts,js,mjs}` are checked and imported on process restart,
   never hot-swapped during execution. Import/registration does **not** grant
   their tools: kit selection currently allows only the built-in coding tools.

Shell, extensions, checks and preview are **trusted code sharing app-account
permissions, not containment**. A separate configured preview DB is not protection
from arbitrary code reading live data. Cleared shell environment variables do
not prevent access to credentials through other same-account mechanisms. A cwd
is not a filesystem sandbox. There is no migration runner, DB rollback, resource
quota, release GC, zero-downtime activation or cross-host deployment.

## Deployment and operator gates

The target is **native Mac Mini / localhost / Tailscale / launchd**, not a Linux
VM. [Mac preparation](deploy/mac/README.md) includes a read-only preflight and the
remaining operator gates. Darwin process handling exists but has not been
executed on a Mac. Do not install the final host daemon before Phase 4 hardening.

The existing Linux root-supervisor exercise requires an exclusive non-root app
UID: activation/recovery kills all its processes. Never use a shared or human
account. The disposable orb fixture uses UID 65534 only after confirming it has
no unrelated processes. Production Node/installation must be root-owned and
outside replaceable releases. No user creation, root Node install, launchd,
Tailscale changes, credential entry, repository visibility changes or Mac
deployment are performed by this milestone.

## Verification

`npm run check` runs TypeScript, Dillon Mulroy's unchanged vendored anti-slop
Oxlint rules, Effect integration tests using real disposable SQLite/faux, and
the production client build. Kit tests cover busy/inbox transitions, denied
authority, safe forks/raw children, model choice, queued/steered input and legacy
DB refusal. Existing coding/recovery/source-gate and process/preflight tests stay.
Phase 2 tests add real image/PDF decoding, concurrent original publication,
attachment replay/branch/reopen and download scope, DNS pinning/rebinding,
private/redirect/unknown-URL denial and hung/cancelled requests. Native Research
tests check complete long-source output, numbered provenance, user-role summary
spoof denial, cross-kit tool denial and reopen. Push tests cover disabled keys,
endpoint validation, concurrent receipts, terminal failure, recovery and revocation.
Removed Arena tests describe removed behavior, not current acceptance coverage.

For the **disposable Linux orb only**, after checking the fixture UID is unused:

```sh
sudo node --import tsx tools/builder-demo.ts --exercise /tmp/still-phase2-demo
```

Use a new root for each independent run. This real offline workflow exercises Pi
tools, replay, immutable source, checks, preview, exact approval, SIGKILL/orphan
cleanup, pending recovery, rollback and staged protected/type/lint rejection.
It records `evidence.json` without tokens. It tests orchestration, not autonomous
model quality, Mac operation or hostile-code isolation. Its root-only
`demo-config.json` contains a secret and must not be shared.

Kit Langton's Effect guidance and Dillon's rules retain their licenses and
upstream provenance under `.agents/skills/using-effect` and `tools/oxlint`.
