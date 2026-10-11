# Still

An original iPhone-first chat prototype built on Pi Durable 1.0.2 and Effect 4.0.0.
Inspired by [Pi Pocket](https://github.com/TannerMidd/pi-pocket), not a fork.

## Rearchitecture handoff

The authoritative [v1.2 specification](docs/rearchitecture-and-product-spec.md)
defines the native Mac deployment, Chat/Research/Still kits, generic agents and
fresh-state cutover. Implementation is incremental; target features are not
current capabilities merely because the specification describes them.
The earlier [baseline provenance and design](docs/rearchitecture-design.md)
remains historical evidence, not the current implementation contract.

## Run

Use Node 26.10.0, then `npm ci` and `npm run dev`. In an Amp orb, use
`amp orb services ensure` and open the generated portal. `.agents/setup` installs
the pinned runtime and dependencies; `.agents/resume` restores the orb's Oxlint
allocator prerequisite. These lifecycle files must reach the default branch to
apply to future orbs.

Configure at least one server-side secret: `OPENCODE_GO_API_KEY`,
`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. Credentials never go to the browser.
Model requests use your provider account and may incur charges. Normal operation
has no mock fallback. Tests and the explicitly configured `STILL_FAUX_DEMO`
offline demonstration use Pi's scripted faux provider and are labeled as such.

## First slice

- Streaming Markdown chat, model selection, stop, and queued follow-ups.
- SQLite-backed conversations and reconnectable SSE snapshots.
- Local browser drafts and stable request IDs for retrying uncertain sends.
- Responsive phone/desktop layout and an install manifest.
- Chat-only authority: no shell, files, tools, or browser authority. Host-only
  task and request-audit extensions never expose delegation as a model tool.
- User-triggered `/delegate` and `/arena` with one to five configurable slots,
  fresh brief or an inclusive frozen history boundary, and normal child chats.
- Per-child stop/retry, group stop, one-result-at-a-time comparison, explicit
  selected-result return, and explicit synthesis as a separate child workload.
- Explicit trusted-owner Builder: candidate coding, checks, disposable preview,
  exact-version approval, supervised activation/recovery/rollback, and extensions.

This is a mobile web prototype, not a native iOS app. Voice, attachments,
notifications and offline client operation are not implemented. Workspace tools
exist only in explicitly authorized Builder conversations. Durable background tasks survive browser disconnects and server
restart, but this orb is not an always-available production host. Safari keyboard
and home-screen behavior need real iPhone
testing. Models are fixed per conversation for now.

## Boundaries

React is the view layer; Effect owns decoded API calls, server services,
configuration, typed failures, scoped SQLite/watch resources, and streaming.
Pi Durable owns the transcript, submissions, queue, and recovery. A custom
Durable document stores title/model metadata; it is read separately because
ConversationView only mounts built-in documents.

## Delegation authority and lifecycle

One `Chats` Effect service owns one scoped Harness and one SQLite database.
`POST /api/chats/:id/groups` decodes `LaunchGroup`; a single Harness transaction
records the group, background coordinator, each background anchor, independent
child conversation, worker task, model configuration and chronological card
entry. No provider request occurs in this transaction. Child tools are empty;
only the request-audit extension is selected. The child API rejects recursion.

```text
React setup sheet / command
          │ schema-decoded request
          ▼
Chats Effect service ──► one Harness / SQLite
                            │ atomic durable launch
                  ┌─────────┴──────────┐
                  ▼                    ▼
          coordinator              background anchors
          checkpoint: join          │ one per attempt
          allSettled ◄───────────────┤
                                    ▼
                              candidate worker
                                    │ stable submission request ID
                                    ▼
                              independent child chat
                                    │
                                    ▼
                              provider generation
```

The coordinator joins candidate workers with `allSettled`; workers update the
parent's custom group document independently. SSE observes both the built-in
chat view and custom group commit publications. Disconnect stops only this
observer, not durable execution. Parent `Stop response` does not cross the
conversation-owned background anchors. Per-child/group stop admits a durable
cancellation task with the relevant anchor and child conversation IDs. It aborts
the anchors and explicitly aborts those child conversations, including current
continuations and queued input. Terminal anchors alone cannot stop later turns.
Completed initial results remain available; card statuses describe the initial
attempt, not every later child turn. Stop group remains available after initial
attempts settle. Older replaced attempts are separate retained conversations.

Cancellation is cooperative and executes when the durable task runs; it cannot
revoke provider billing for an already-sent request. Conversation abort scans
current work when executed. A crash replay can repeat that scan in the captured
child conversations, so it is not an admission-time task-set guarantee. Wait for
cancellation to settle before starting new child work.

Retries allocate a new anchor, worker and child from the original boundary, with
a new provider session. The previous conversation remains in history. An old
worker cannot update a replacement attempt. Launch and retry request IDs prevent
duplicate local admission; they do not ensure exactly-once inference/billing
after a crash. Existing in-flight generation checkpoints retain their model,
cutoff and provider session on recovery.

`Use this answer` admits a passive write with a deterministic result ID. It
copies only that attempt's completed answer into a labeled parent user message;
it does not start a model turn. When the parent is busy, Pi queues the write for
the next boundary. A child's later edits do not silently change the returned
result. Synthesis is an explicitly launched fresh child containing the task and
completed answer snapshots, with its own chosen model and session.

Synthesis has a separate internal limit of 128000 characters, including its
instructions, task and answer labels; user prompts remain limited to 16000.
Oversized synthesis returns an actionable 413 before admitting any work, without
truncating answers. This character budget is not a token count or a guarantee
that a particular model's context window can fit it. The first admission freezes
the source answers, task and model in the same transaction as child creation.
Replaying its request ID returns that workload even after source completion or
retry; a new request ID explicitly selects a new snapshot. Reusing the ID for a
different source or model returns 409.

## Context and cache evidence

```text
Parent: brief ─ answer (#14) ─ later message ─ selected result
                       │ explicit frozen fork, inclusive
             ┌─────────┼─────────┐
             ▼         ▼         ▼
          child A   child B   child C      independent provider sessions
          + task    + task    + task       same task and frozen prefix
          + A reply + B reply + C reply    no sibling/parent-future leakage
             │
          + follow-up                     only A grows

Retry A: original #14 prefix + task        new child/session, not A's divergence
```

`GET /api/chats/:id/audit` exposes a durable, secret-free logical request-hook
audit: ordered message SHA-256 hashes, content character counts, model,
hashed provider-session identity, request hash, and normalized input/output/
cache-read/cache-write usage. Audit documents start fresh on fork and retry.
They store no prompt text or credentials. They are **not wire captures**; Pi's
provider adapter can translate logical messages before sending them.

Pi 1.0.2 gives forks fresh `pi.provider` identities and passes the stable identity
as `sessionId`. Its Go provider wrapper adds `x-opencode-session`. Under default
short cache retention, the non-OpenAI Go completions endpoint gets no generic
`prompt_cache_key`; cache-control markers depend on model/provider compatibility.
The application does not own or invalidate provider KV memory. Model switching,
fresh sessions, and divergent branches are not evidence of shared KV state.

Pi's completions adapter reads cache-hit counters from
`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, or
`cached_tokens`, and defaults absent counters to zero. Positive counters are
reported cache-hit evidence; zero cannot distinguish a miss from absent metrics.
Matching prefix hashes establish a reuse opportunity, not a hit guarantee.
Neither retention, exact cached prefix, underlying device allocation, eviction
policy, nor physical sharing across sessions is observable here.

The fork cutoff is immutable, but that does not promise an immutable effective
prompt forever. A compaction summary visible to a conversation view can replace
earlier messages in its effective prefix. Still exposes no compaction control,
and this verification does not cover compaction or provider-cache invalidation
after compaction. Prefix hash comparisons apply only to the captured,
uncompacted logical requests, not final wire payloads or physical KV state.

Tests use the faux provider and real disposable SQLite. They inspect provider
inputs directly and cover five-way concurrency, frozen-boundary exclusion,
distinct sessions/models, sibling divergence, failure isolation, idempotent
admission/retry/return, cancellation, live custom-document observation, explicit
synthesis, graceful reopening, and actual SIGKILL recovery. Regressions include
five 4000-character synthesis answers, oversized admission rollback, immutable
synthesis replay after late completion/retry/reopen, and group cancellation of a
completed member's running continuation and queued input. These test logical
invariants, not the real provider's cache implementation or compaction behavior.

This single-owner development server binds loopback and relies on Amp portal
access control. Do not expose it publicly or enable shared access without adding
application authentication and authorization. SQLite lives in `.data/` (or
`STILL_DATABASE`); an orb is a prototype host, not a backed-up production database.

## Verify and provenance

`npm run check` runs TypeScript, Dillon Mulroy's vendored anti-slop Oxlint rules,
Effect-aware integration tests against real SQLite, and a Vite production client
build. `npm run dev` remains the development runtime; `npm run host` runs the
independent self-hosted supervisor described below. No shared deployment is
automatically configured or activated.

Kit Langton's Effect skill and Dillon's lint rules retain their licenses and
upstream revisions in `.agents/skills/using-effect/UPSTREAM.md` and
`tools/oxlint/anti-slop/UPSTREAM.md` respectively.

## Builder is an explicit trusted-owner capability

Open **Builder** or enter `/builder <app fix or extension request>`. Unlock with
the supervisor's owner token, select a model, and start a coding candidate. This
creates a normal chronological Pi Durable conversation with `read`, `write`,
`edit`, and `bash`, rooted at a candidate copy. No model tool can activate code
or automatically delegate. Ordinary/arena conversations explicitly select
audit-only extensions and empty tool sets; installing coding tools does not
silently grant them to ordinary chats. A host-level empty extension default
also avoids Pi's otherwise permissive installed-extension default.

The candidate ID is the original request ID. `still.builder` stores candidate,
original task, and model in the same Harness transaction as conversation
creation/configuration. Admission replays submit the same Pi request ID; changed
task/model under that ID returns 409. A disconnect stops the view, not the durable
turn or tools. Durable tool results are inspectable in the child chat. Pi's
built-in coding tools have **unsafe replay**: an interrupted side effect is not
automatically rerun as though nothing happened. Inspect the candidate and ask
for an explicit follow-up; this is not exactly-once shell execution.

```text
┌──────────────────────┐   explicit owner token   ┌────────────────────────┐
│ React Builder sheet  │────────────────────────▶│ Protected supervisor   │
│ request ID + model   │                         │ src/host/main.ts       │
└──────────┬───────────┘                         │ Effect Releases service│
           │ normal chat/SSE                     └──────────┬─────────────┘
           ▼                                               │ copy candidate
┌──────────────────────┐                                   │ no live DB/.env
│ Chats / one Harness  │◀── authorized admission ───────────┘
│ SQLite transcripts   │
│ still.builder doc    │──▶ Pi durable read/write/edit/bash ──▶ candidate source
│ submissions + tasks  │
└──────────────────────┘
```

The supervisor journal stores **release lifecycle**, not a second conversation
or prompt store. Pi/SQLite remains the sole transcript, submission, and tool-task
authority. Effect owns Config, service/API boundaries, scoped process lifetime,
serialized owner operations, and readiness polling. The low-level Node process
adapter sets real Linux UID/GID and manages filesystem snapshots/processes.

## Checks and preview do not activate mutable source

**Run checks / preview** copies the current candidate to staging. Fixed external
TypeScript, Dillon Oxlint, Vitest, and Vite commands run as the app account with
a sanitized environment. Candidate package scripts cannot replace these gates.
Protected/dependency/persistence gates inspect that staged copy, not an earlier
read of the mutable candidate. TypeScript includes `extensions` (including checked
JavaScript); fixed Oxlint targets enumerate its staged files. An absent extension
directory is valid. Successful module import is not a substitute for either gate.
Source hashes before/after checking must match. The supervisor copies checked
source plus built client assets into a content-addressed release, verifies the
digest, and makes it supervisor-owned/read-only. Dependencies are linked from
the protected installation; candidate caches are separate and dependency changes
are rejected. The diff and check output refer to that immutable snapshot.

A version-bound preview URL runs that release with a **separate SQLite file**,
no provider keys, no Builder admission token, and no connected providers. An old
URL returns 410 rather than silently displaying another candidate. Only one
preview runs at a time; restart/activation invalidates its URL. Preview modules
and shell/check commands remain trusted app-account code, not a hostile-code
sandbox. The configured DB is separate; arbitrary trusted code could still read
other app-account files. Do not treat preview as confidentiality isolation.

**Approve exact version / activate** requires the owner token header and the
candidate ID plus full validated digest. A browser/session cookie alone cannot
activate code. Later mutable candidate edits are not promoted by an old approval.
Stale-base candidates must be recreated from the current active version. The
confirmation names the exact digest and warns that code rollback does not undo
database writes. Authorization in the original task is not interpreted from
model prose: this slice always requires the separate explicit activation action.

```text
candidate ── snapshot ── fixed checks ── immutable release ── disposable preview
                                                       │
                                            explicit owner approval of hash
                                                       ▼
                               fsync journal.pending BEFORE stopping app
                                                       │
                           stop app/preview and dedicated-account descendants
                                                       │
                            start approved release on SAME live SQLite
                                                       ▼
                               /healthz: ready + exact release + extensions
                                ┌──────────────────────┴────────────────────┐
                                ▼                                           ▼
                       commit active/previous                   failed startup/readiness
                       clear pending + fsync                    restart old active release
                                                                keep old active; report rollback
```

Readiness checks an actual SQLite-backed chat listing and reports release and
loaded-extension identity. It does not prove every UI feature or user workflow
correct. A two-second supervisor pass also detects exit/readiness failure and
restarts, falling back to the prior release if necessary. The supervisor code
and dependencies live **outside** the replaceable release; its owner API stays
reachable when the app fails. Automatic restart is scoped to this local host,
not a deployment API or an Amp/E2B operation.

## Recovery restores committed code, not database history

The journal is written with file/directory fsync and atomic rename. Startup
cleans stale app/check/shell processes belonging to the dedicated app UID,
matches recorded PID start times to avoid PID reuse, and rejects a second live
supervisor for the same host state. A pending, uncommitted activation is abandoned
after a hard crash; the last committed healthy release starts instead. Committed
activation survives restart. SQLite stays outside release directories and opens
again; completed tools/transcripts remain visible. An interrupted coding tool
must be inspected rather than blindly repeated.

This first slice rejects changes to existing chat/delegation/audit/Builder
persistence definitions, supervisor source, dependency manifests, and filenames
containing `migration`. There is **no migration runner**. This is a concrete
change gate, not a proof that arbitrary trusted code cannot change data. Source
or extensions can perform other writes using their trusted authority. Back up
SQLite, and handle intentional migrations explicitly outside Builder. Restoring
code never promises to undo DB changes, provider calls, filesystem writes, or
external side effects. Release retention/GC, zero-downtime activation, resource
quotas, multi-owner authentication, and cross-host deployment are not included.

## Extensions load only after approved restart

Builder may create `extensions/<name>.ts` (or `.js`/`.mjs`), default-exporting a
Pi Durable `defineExtension` with name `still.extension.<name>`. Still imports
trusted modules, checks names/collisions, and installs them in the same registry
at startup. New Builder conversations select these extensions; ordinary chat
does not. Existing conversations keep their stored selection; same-name module
implementation changes take effect on restart. There is no in-flight registry
hot swap. Extension top-level imports execute on startup, including preview:
they are owner-trusted executable code, not safe because a schema accepted a
manifest. A bad startup import fails readiness and can trigger code rollback.

## Self-hosting needs a protected Linux supervisor and a dedicated app account

Install Still and `npm ci` under a supervisor-owned, non-app-writable path such
as `/opt/still-host`; never point the supervisor at a replaceable release as its
installation. Use Node 26.10.0. Run the small supervisor as root with a dedicated,
non-root app UID/GID, reserved **exclusively for this one Still host**. The
supervisor kills all processes for that UID during activation/recovery/close,
including Pi bash's detached groups. Do not share it with unrelated services or
use a human account. `nobody` is used only by the disposable orb demo.

Configure a root-readable environment file outside source/candidates:

```sh
STILL_HOST_SOURCE=/opt/still-host
STILL_HOST_ROOT=/var/lib/still-host
STILL_APP_UID=<dedicated numeric uid>
STILL_APP_GID=<dedicated numeric gid>
STILL_OWNER_TOKEN=<at least 32 random characters>
PORT=3000
# Optional provider keys remain server-side here; never copy this file to source.
```

Run `node --import tsx src/host/main.ts` from `/opt/still-host`, normally with
systemd or another persistent host process manager. It binds loopback on PORT
and uses PORT+1/+2 internally. Put it behind your own authenticated TLS reverse
proxy; forward `x-forwarded-proto: https` for secure owner-session cookies. The
ordinary chat API is single-owner and has no public multi-user authentication.
Builder's owner token is not a replacement for protecting the entire chat UI.
Secrets are never embedded in client HTML or source copies. The source allowlist
excludes `.data`, `.env`, git metadata, and dependency caches; **do not place
credentials inside source files**. OS ownership protects live source from the
app account; cwd/read-only modes with the same OS user would not suffice.

Product startup/Builder/activation needs no Amp CLI, E2B key, or orb API. Amp's
managed service/portal is only used to expose the temporary development demo.
This Linux/root design is intentionally narrow; other OSes or same-user hosting
are refused, not presented as equivalent protection.

## Reproduce the exercised offline workflow

`sudo node --import tsx tools/builder-demo.ts --exercise /tmp/still-builder-demo`
creates disposable host state, uses a scripted **faux** model, and runs real Pi
coding tools, checks, preview, explicit activation, SIGKILL restart, pending
activation recovery, live-only startup failure rollback, and persistence-change
rejection. Assertions check files, immutable digests, status codes, readiness,
extension identity, and preserved transcripts; `evidence.json` records outcomes
without tokens. This tests orchestration, not autonomous model quality. It makes
no live/paid model requests. Use a fresh root path for each independent run.
Regressions inject a protected edit at the actual filesystem copy boundary using
a test-only process fixture (no supervisor hooks), and reject importable
type-invalid and type-valid/lint-invalid extensions before admitting a version.

For an interactive demo, run `--prepare <root>` once and `--serve <root>` under
your development process manager. The root-only `demo-config.json` contains its
owner token; do not publish it. `STILL_FAUX_DEMO` is an explicit offline fixture,
not a fallback when credentials fail. Existing context/cache audit claims above
remain limited to logical hooks and reported usage, not physical KV guarantees.
