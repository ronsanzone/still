# Still — Rearchitecture and Product Design Specification

| | |
|---|---|
| **Version** | 1.2 · 2026-10-11 · authoritative |
| **Owner** | Ron Sanzone |
| **Author** | Opus 5.5 |
| **Baseline** | `ronsanzone/still` `main` @ `5755703` |
| **Supersedes** | Earlier review and planning notes |

No application code was changed to produce this document.

## Changes in v1.2

v1.2 applies two decisions.

**1. Pi Durable primitives come first.**
- Still uses Pi Durable's own primitives directly. The proposed wrappers are deleted: DurableStore, ExecutionTarget and WakeScheduler.
- Every reused primitive was checked against the pinned 1.0.2 sources (§3.3).
- Anything that belongs to Still alone is tagged **[STILL]**.
- These doc and entry types are removed because Pi already provides the information:
  - `still.urls` (URL provenance is now read from the transcript);
  - `still.agent-link` (use `ConversationRecord.owner`);
  - `still.branch` (use `ConversationRecord.parent`);
  - the `still.report` entry (a report is now a pointer to the child's answer entry).

**2. v1 runs natively on the Mac mini.**
- Services listen on localhost only, HTTPS comes only through Tailscale, and launchd keeps them running. Lima and Linux-first guidance is gone.
- Linux and Cloudflare remain later adapters. Their capability differences are stated honestly in §13.

**Correction to v1.1.** `registerEnvConformance` does **not** exist in 1.0.2; only `registerStorageConformance` does. `Shell.exec` takes a command **string**.

## Tags used in this document

**Code status**
- **[NOW]** exists at `5755703`.
- **[TARGET]** is to be built.
- **[DEFERRED]** is designed but explicitly not built in v1.

**Origin**
- **[PI]** is a Pi Durable 1.0.2 primitive, used directly.
- **[STILL]** is defined by Still on top of Pi.

**Decision status**
- **Ron:** Ron decided it.
- **Default:** this spec's choice, made under "use your judgment". Reversible.
- **Open:** waits on an action or a probe.

---

## Contents

1. Executive summary
2. Decisions
3. Current implementation, and Pi Durable 1.0.2 as the substrate
4. Product identity and jobs
5. Information architecture
6. UX and key flows
7. Still-specific durable definitions (the whole list)
8. Kits and enforcement
9. Agents and reports
10. Dependency architecture, the kernel, extensions, and seams
11. Research and attachments
12. Self-modification: the ReleaseHost contract and the trust chain
13. Deployment: native Mac mini v1; Linux and Cloudflare later
14. Cutover (no migration)
15. Phased implementation
16. Acceptance criteria
17. Tests and threat probes
18. Observability
19. Backups and rollback
20. Non-goals
21. Blockers, probes, accepted risks
22. ADRs
23. Evidence

---

## 1. Executive summary

**Still** is a calm, durable, self-hosted assistant for one technical owner, used mostly from an iPhone. You can:

- ask it anything, or attach a photo or PDF;
- send it off to research, lock the phone, and get a cited answer with a push notification;
- have it extend itself. A change ships only after you approve the exact release digest with Face ID, on a page served by the supervisor.

**Architecture: Pi Durable is the substrate, Still is a thin layer on top.**

Pi provides storage, conversations, entries, docs, submissions with steer/queue/write, forks, tasks with waits and sleeps, owned/background ownership, tools, hooks, extensions, `env()`/`ExecutionEnv`, watches, the task graph, usage, and crash recovery.

Still adds only six things:
1. a **Kit** doc (`chat`, `research` or `still`, plus a target), enforced through `env()`, in-tool checks and a hook;
2. an **agents** tool with three small tasks, where a report is a projection over the child's answer entry;
3. a **ReleaseHost** contract covering candidate, validate, preview, approval, activation and rollback;
4. two provider seams, **SearchProvider** and **Notifier**;
5. the kernel's protected-file rule;
6. the UI.

**Deployment v1: native on the Mac mini.**
- A root LaunchDaemon runs the supervisor.
- The app runs as a dedicated hidden macOS user, `_still`.
- Services bind to `127.0.0.1`. `tailscale serve` provides HTTPS on the tailnet; nothing is public.
- Backups run from launchd and are also covered by Time Machine.
- Linux (systemd, plus bubblewrap containment later) and Cloudflare (Workers plus Durable Objects, with no shell and no self-edit) are later adapters behind the same Pi Storage and env seams and the same ReleaseHost contract.

**Honest limits**
- v1 does not contain tool execution. A conversation using the `still` kit runs shell commands as `_still`. That user can read the provider keys in the app process and can read and write the app database. It **cannot** read Ron's home directory or change releases. Containment is deferred (Q7).
- There are no spending budgets (Q1) and no research limits (Q6).
- There is no migration: Phase 1 starts with a fresh database (Q4).

**v1 = Phases 0–4.**

---

## 2. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Mac mini is the physical host. **v1 runs natively on macOS**; no VM. | Ron |
| D2 | Tailscale-only HTTPS; services listen on localhost only | Ron |
| D3 | Trusted single owner; practical containment where cheap | Ron |
| D4 | v1 = `chat`/`research`/`still` kits, attachments, cited research | Ron |
| D5 | Web Push | Ron |
| D6 | Generic bounded agents replace Arena | Ron |
| D7 | Foreground reports; passive background reports; continuation is opt-in and happens once | Ron |
| D8 | Approval of the exact digest by passkey/Face ID, on the supervisor | Ron |
| D9 | Builder is removed as a mode; the protected self-release path stays | Ron |
| D10 | Pi Durable pinned at 1.0.2 | Ron |
| D11 | **Use Pi Durable primitives directly.** No DurableStore, ExecutionTarget or WakeScheduler wrappers. | Ron (confirmed here, §3.3) |
| D12 | Still-specific concepts stay minimal: the Kit doc, report projection, ReleaseHost, plus SearchProvider and Notifier where warranted | Ron (refined here, §10) |
| D13 | Tailscale, launchd, systemd, backups and provisioning live in deployment code, with no interfaces until a second implementation exists | Ron |
| D14 | Leave clean boundaries for later Linux and Cloudflare adapters. Cloudflare need not support shell or self-edit. | Ron |
| Q1 | No agent budgets and no daily spending caps | Ron |
| Q2 | Report consumption is as simple as possible (§9.4) | Ron → Default |
| Q3 | Grant semantics are as simple as possible (§8.3) | Ron → Default |
| Q4 | No legacy migration or compatibility | Ron |
| Q5 | Hosting details (§13, §19, §12.5) | Ron → Default |
| Q6 | No research limits; cheap models for development | Ron |
| Q7 | Containment deferred, and stated honestly | Ron |
| — | The app runs as dedicated user `_still`, never as Ron (§13.2) | **Default, firm** |
| — | Chats \| Work tabs; model changes only between runs; retry and edit create a fork | Default |
| — | Search: Brave Search API behind `SearchProvider` | Default (needs a key, §21) |

---

## 3. Current implementation, and Pi Durable 1.0.2 as the substrate

### 3.1 Repository [NOW]

- **Repo:** `github.com/ronsanzone/still`, **public**. `main` @ `5755703`, 89 files, clean checkout at `~/code/still`.
- **Check results:** `npm ci && npm run check` passed: typecheck, oxlint, 22/22 Vitest tests, and the Vite build. Reported on Node 26.8.2.
- **Archive identity:** byte identity with the reviewed archive is unverified.
- **Pi primitives already used directly:**
  - `openNodeSqliteStorage` (`chat.ts:25,270`);
  - `harness.resume()` (`chat.ts:293`);
  - `Conversation.watch()` for SSE (`chat.ts:921`);
  - `forkConversation`/`createConversation` with task ownership, background anchors and `allSettled` waits (`delegation.ts`).
- **Still-specific today:**
  - Arena docs and tasks;
  - the Builder doc;
  - the audit doc;
  - the supervisor.

| Area | Files (lines) | Fate |
|---|---|---|
| Chat service / Harness | `src/server/chat.ts` (1059) | Split into `src/kernel/*` and `src/server/chats.ts` |
| App HTTP | `src/server/main.ts` (366) | Routes rewritten |
| Arena | `src/server/delegation.ts` (434), `src/client/delegation.tsx` (397) | Deleted (Phase 1). Its fork/anchor patterns are reused in `src/kernel/agents.ts`. |
| Builder | `src/server/builder.ts` (90), `src/client/builder.tsx` (265), `src/shared/builder.ts` | Deleted (Phases 1 and 4). The extension loader moves to the kernel. |
| Audit | `src/server/audit.ts` (108) | Deleted. Replaced by `pi.usage`. |
| Supervisor | `src/host/{releases,main,files}.ts` (793/316/159) | Kept. The Linux `/proc` code moves into platform functions (§13.4). |
| Client | `src/client/app.tsx` (860) | Split |

### 3.2 Behavior today [NOW]

**Chat**
- Model and tools are fixed when a conversation is created (`chat.ts:341-373`).
- Chats have no tools.
- Builder chats get `cwd = candidates/<id>` plus `read`/`write`/`edit`/`bash`.
- `env = ({cwd}) => new NodeExecutionEnv({cwd})` (`builder.ts:88-90`). This sets the working directory only.
- Admission uses `whenBusy: "followUp"`. There is no `beforeTool` hook.

**Supervisor**
- Linux-only: it requires root, reads `/proc/<pid>/stat`, and kills by scanning `/proc` (`releases.ts:106-175, 349-356`).
- Owner auth accepts a header **or** a cookie (`host/main.ts:28-36`).
- The cookie is marked `Secure` only behind `x-forwarded-proto: https` (`:109`).
- Preview is served from the same origin, at `/builder-preview/<digest>/` (`:273-295`).

**Release checks**
- Checks run `tsc`/`oxlint`/`vitest`/`vite` with configs and tests the candidate controls (`releases.ts:310-325`).
- Protected paths are listed at `:285-304`. `src/client/builder.tsx` is **not** on that list.
- Provider keys and `STILL_INTERNAL_TOKEN` are passed to the app through its environment (`releases.ts:394-415`).

### 3.3 Pi Durable 1.0.2 reuse map [PI], verified

Paths are relative to `node_modules/@earendil-works/pi-durable/` (`"version": "1.0.2"`).

| Need | Pi primitive used directly | Verified at | Replaces |
|---|---|---|---|
| Persistence | `Storage` interface; `openNodeSqliteStorage(path)`; portable `SqliteStorage.open(db: SqliteDatabase)`; `MemoryStorage` for tests; `registerStorageConformance` | `dist/types.d.ts:787`; `dist/storage/sqlite/node.d.ts:39`; `dist/storage/sqlite/storage.d.ts:15`; `dist/testing/index.d.ts:2`; README:529 ("…run without Node APIs, for example on Bun or in Cloudflare Durable Objects, given an asynchronous `SqliteDatabase` facade") | ~~DurableStore~~ |
| Single writer, atomic commits | Harness "all changes go through one line of atomic commits"; "one process owns a storage at a time" | README:80, 529 | Custom locking |
| Execution target | `HarnessOptions.env(target: EnvTarget)`. `EnvTarget = {conversationId, cwd?, read: DocumentReader}`. It returns an `ExecutionEnv` (`FileSystem & Shell`, with a stable `id`) or `undefined` | `dist/harness/types.d.ts:356,368`; `dist/env/index.d.ts:50,106,109`; README:233-247 | ~~ExecutionTarget~~ |
| Local shell | `NodeExecutionEnv({cwd, shellPath?, shellEnv?})`; `exec(command: string, …)` | `dist/env/node.d.ts:10-17` | — |
| Timers, waits, wake-ups | Task phases with checkpoints; `runtime.sleep(until)`; `status: "waiting"` with `on` + `JoinPolicy` (`"failFast" \| "allSettled"`); scheduler resumes after restart | `dist/types.d.ts:184, 225, 439`; README:446-471 | ~~WakeScheduler~~ |
| Recovery | `Harness.open` + `harness.resume()`; replay-safe tools (`replay: "safe"`); `requestId` dedupe | `dist/harness/types.d.ts:146`; README:101-125 | — |
| Conversations, forks | `createConversation`, `forkConversation(parent, at, {ownership})`, `Conversation.fork(at)`. `ConversationRecord.parent {conversationId, at}` and `.owner {conversationId, taskId}` | `dist/types.d.ts:249, 254, 683`; `dist/harness/types.d.ts:454` | `still.branch`, `still.agent-link` |
| Submissions | `submit({type:"input", whenBusy: "steer"\|"followUp"\|"reject"})`; `submit({type:"write"})` for passive entries | `dist/harness/types.d.ts:20`; README:291-309 | — |
| Agent config | `configure(tx, conversationId, change)` (model, tools, extensions, cwd); `AgentDoc` (`pi.agent`) | `dist/harness/agent.d.ts:12` | Model field in `still.chat` |
| Tools, hooks, extensions | `defineTool` (`details`, `commit`, `conversation`, `createTask`, `waitForTask`); `hook(ToolTask, {beforeTool})`; `hook(GenerationTask, {beforeRequest, afterResponse})`; `defineExtension`; `createRegistry` | `dist/harness/types.d.ts:128-138, 520-542`; `dist/index.d.ts:6,13` | — |
| Your own state | `defineDoc` (scopes `session\|conversation\|task`; history `latest\|rewindable`; `fork` policy; `version` + `migrate`); `defineEntry` | `dist/types.d.ts:30-50, 64`; `dist/index.d.ts:1-2` | — |
| Run state | `LiveDoc` (`pi.live`), `InboxDoc` (`pi.inbox`), `UsageDoc` (`pi.usage`), `harness.usage()` | `dist/harness/live.d.ts:68`; `inbox.d.ts:20`; `usage.d.ts:11` | Audit doc, spend ledger |
| UI streaming | `Conversation.watch()` / `viewState()`; `harness.taskGraph()` / `watchTaskGraph()`; `harness.inspect()`; `Session.documentState()` | `dist/harness/types.d.ts:468, 472`; README:261-289, 473-487 | Custom Work-tab tracking |
| Images | pi-ai `UserMessage.content: string \| (TextContent \| ImageContent)[]` | `pi-ai/dist/types.d.ts:369-371` | — |
| Subagent pattern | README examples 22 (foreground, replay-safe tool) and 23 (background anchor; parent stays idle) | README:399-444 | Arena coordinator |

**Not in 1.0.2, and not assumed:**
- `registerEnvConformance` (later versions only);
- an in-place conversation rewind;
- argv-based `exec`;
- `openBinaryReader` / `openDirReader`.

---

## 4. Product identity and jobs [TARGET]

> **Still: a calm, durable assistant you own. Send it off, lock your phone, get a cited answer. Teach it new tricks; it changes only when you approve with your face.**

**Pillars**
- **Owned:** your machine, your keys, any model, one SQLite file.
- **Durable:** work survives sleep, closed tabs and restarts.
- **Teachable:** it extends itself through reviewed releases that can be rolled back.
- **Calm:** answers come first; tool work stays collapsed.

**Rule:** Read anywhere. Write only in a target. Release only with your face.

**Not:** a mobile IDE, a remote for the Pi CLI, a multi-user SaaS, or a sandbox.

| # | Job | Kit | Ships in |
|---|---|---|---|
| J1 | Quick ask / think | chat | v1 |
| J2 | "Go find out": cited, in the background, with a push | research + agents | v1 (killer job) |
| J3 | "Look at this": photo, PDF | any | v1 |
| J4 | Compare models | agents | v1 |
| J5 | Fix or extend Still from the phone | still | v1 |
| J6 | Teach a trick without code | data tier | v1.1 |
| J7 / J8 | Scratch compute; schedules | — | Deferred |

**Gate:** after the Phase-0 dogfood week, fix J1 before any platform work.

---

## 5. Information architecture [TARGET]

**Origins**

| Origin | URL | Serves |
|---|---|---|
| App | `https://still.<tailnet>.ts.net` | Chats tab: list and branches. Conversation: timeline, cards, context bar (model · kit · $), composer (📎, `/`, send). Work tab: Needs you · Running · Reports · Releases · System. Settings. |
| Preview | `https://still.<tailnet>.ts.net:8443` | One release digest, with a scratch database and no provider keys |
| Approval | `https://still-approve.<tailnet>.ts.net` | Supervisor-owned release card, diff, checks, Face ID approve and roll back, passkey enrollment, status |

**App routes:** `/`, `/c/:id`, `/work`, `/settings`.

**Navigation:** a bottom tab bar on phones; a sidebar on wide screens.

**Work tab sources**
- **Needs you:** fetch confirmations, settled-but-unconsumed batches, releases that are ready.
- **Running:** a projection of `harness.watchTaskGraph()` [PI].
- **Reports:** a projection over `still.agents` [STILL].
- **Releases:** `ReleaseHost.status()` [STILL].
- **System:**
  - last backup;
  - session spend from `harness.usage()` [PI];
  - blocked or orphaned tasks from `harness.inspect()` [PI].

---

## 6. UX and key flows [TARGET]

### 6.1 Context bar and composer

```text
◉ <model> ▾ · 🔎 research ▾ · $0.04
[📎] Ask anything…                                   [/] [↑]
```

**Model chip**
- Changes take effect between runs.
- Writes a `still.model-change` entry.

**Kit chip**
- Choices: `chat` · `research` · `still`. Disabled while a run is busy.
- Choosing `still` opens a sheet: "Attach a candidate copy of Still. This chat can edit it and run shell commands as the `_still` service user, which can read provider keys and the app database (no sandbox yet). Nothing ships without Face ID."
- If the chat contains fetched or attached content, the sheet also warns about that.

**Cost chip**
- Shows `pi.usage` × the price table.
- Display only.

**Send button**
- While a run is busy, Send becomes **Steer** or **Queue** (`whenBusy`) [PI].

**Stops**
- **Stop** (`Conversation.abort`) [PI] aborts the run and any foreground children.
- **Stop agents** (`abort({background:true})` on the anchors) [PI] stops background children.

**Slash commands:** `/research`, `/ask <model>`, `/compare [n]`, `/agents`, `/build`, `/kit`, `/model`, `/branch`. They are templates, not modes.

### 6.2 Timeline

- **Answer first.** Tool work collapses into a summary line (`Searched 2 · read 3 pages · 14 s ▸`).
- **Always visible:** blocked calls, writes, cost, and calls with uncertain effect.
- **Agent card:** one row per child showing model, kit, status, cost and `open ↗`. Foreground rows come from the tool's `details` [PI].
- **Batch card:**
  - rows fill in as children settle;
  - one button: **Continue with these reports**;
  - once used, it shows `Consumed ✓`.
- **Comparison:** swipe between answers on a phone; side by side at ≥900 px.
- **Kit and model changes:** grey system lines.
- **Release card:** data comes from the supervisor. It shows:
  - the digest;
  - checks and baseline results ✓/✗;
  - files changed and lines added/removed (+/−);
  - protected files touched, which must be 0;
  - a preview link;
  - a model summary, labelled as such;
  - **Review & approve ↗**.

### 6.3 Flows

**F1 — Ask**
1. Send a message.
2. The answer streams in through `watch()` [PI].
3. Lock and unlock the phone; the client reconnects to the current view.

**F2 — Send it off**
1. `/research <q>` switches the kit to research.
2. The model spawns a background batch of up to 5 research children.
3. Lock the phone.
4. One push arrives when the batch settles.
5. Tap **Continue**: one parent turn synthesises the answer with citations.

**F3 — Look at this**
- Images are downscaled on the client and sent as `ImageContent` [PI].
- PDF text is extracted on the server and fenced.

**F4 — Compare**
- `/compare 3 <q>` runs three foreground children at the same cutoff.
- Results come back in the same run.

**F5 — Teach Still**
1. `/build <request>`, then confirm the sheet.
2. `ReleaseHost.createCandidate`.
3. The model edits the candidate through `env()` → `NodeExecutionEnv(candidate)`.
4. The `release` tool calls `validate`.
5. The release card appears and a push is sent.
6. On the approval origin, approve with Face ID.
7. `activate`. If readiness fails, rollback is automatic.

**F6 — Retry / edit**
- `Conversation.fork(at)` [PI] at the previous entry.
- The branch link comes from `ConversationRecord.parent` [PI].
- A branch starts in the `chat` kit (§8.3).

**F7 — First run**
1. Run the installer.
2. Enroll a passkey on the approval origin (§12.5).
3. Add the app to the Home Screen and allow notifications.
4. Pick a model.
5. A three-card tour.

---

## 7. Still-specific durable definitions (the whole list) [STILL]

Everything else is a Pi built-in. Every definition below is `version: 1` with no `migrate`, because the database is fresh (Q4).

### 7.1 Docs

| Kind | Semantics | Shape | Written by |
|---|---|---|---|
| `still.chat` | conversation · latest · fork `initial` | `{title}` | The chat service. The model is read from `pi.agent`, not stored here. |
| `still.grant` | conversation · latest · fork `initial` | `{kit: "chat"\|"research"\|"still", target: string\|null}`. `initial()` = `{kit:"chat", target:null}` | The kit endpoint (only when idle) and child creation |
| `still.agents` | conversation · latest · fork `initial` | `{batches: Batch[]}` (§9.2) | The `agents` tool and kernel tasks |
| `still.push` | session | `{subscriptions: {endpoint, keys, createdAt}[]}` | Push subscribe and unsubscribe |

### 7.2 Entries

All entries are created with `defineEntry` [PI] and written as passive `write` submissions.

| Kind | Data |
|---|---|
| `still.kit-change` | `{from, to, target}` |
| `still.model-change` | `{from, to}` |
| `still.fetch-confirm` | `{url, decision}` |
| `still.release-card` | `{candidateId, digest}`. A pointer; the supervisor supplies the content. |

### 7.3 Tasks

Tasks are created with `defineTask` [PI] inside the `still.kernel` extension.

| Task | Owner (Pi ownership) | Purpose |
|---|---|---|
| `still.agent-anchor` | parent conversation, `background: true` | Owns one background child conversation, following Pi example 23 |
| `still.agent-run` | the anchor (background), or the `agents` tool task (foreground) | Submits to the child, waits, then records `answerEntry` |
| `still.agent-batch` | parent conversation, `background: true` | `waiting` on its runs with `allSettled` [PI]; sends one push; consumes once if `auto` |

**Tools:** `agents`, `web_search`, `web_fetch`, `release`, all made with `defineTool` [PI].

**Hook:** `beforeTool` backstop [PI].

### 7.4 Removed in v1.2 (Pi already provides these)

| Removed | Replaced by |
|---|---|
| `still.urls` | A scan of the visible transcript (§11.2) |
| `still.agent-link` | `ConversationRecord.owner` |
| `still.branch` | `ConversationRecord.parent` |
| `still.report` entry | A report projection: the child's immutable `answerEntry` plus `pi.usage` |
| `still.spend` | `pi.usage` / `harness.usage()` |
| Audit doc | `afterResponse` usage and `pi.usage` |

### 7.5 State machines

**Kit**

```diagram
┌────────────┐  owner sets kit (idle)  ┌───────────────────────────────┐
│ Idle · kit │────────────────────────▶│ one Pi commit: still.grant,   │
└─────┬──────┘                         │ configure(tools, cwd),        │
      │ send                           │ still.kit-change entry        │
      ▼                                └───────────────────────────────┘
┌────────────┐  kit/model change → 409 Busy (pi.live / pi.inbox non-empty)
│ Running    │  steer/queue → admitted; kit unchanged
└─────┬──────┘
      │ run settles, inbox empty
      ▼
┌────────────┐
│ Idle · kit │
└────────────┘
```

**Background batch**

```diagram
┌──────┐ child settles ┌──────────┐ all settled ┌─────────┐ tap Continue / auto ┌──────────┐
│ Open │──────────────▶│ Filling  │────────────▶│ Settled │────────────────────▶│ Consumed │
└──────┘ answerEntry   └──────────┘ push once   └─────────┘ 1 followUp,         └──────────┘
         recorded                                           requestId consume:<batch>
```

**Release:**
created → edited → staged → gated → checked/baselined → released → previewed → (Face ID) → activating → active.
- If readiness fails at activation, the release is rolled back.
- From active, a Face ID rollback makes the previous release active again.

---

## 8. Kits and enforcement [STILL on PI seams]

### 8.1 Kits

| Kit | Offered tools | `env()` returns | Children allowed |
|---|---|---|---|
| `chat` | `agents` | `undefined` (built-in file and shell tools fail, per Pi) | chat |
| `research` | `web_search`, `web_fetch`, `agents` | `undefined` | chat or research |
| `still` | `read`, `write`, `edit`, `bash` (Pi tools), `release` | `NodeExecutionEnv({cwd: candidatePath})` | none |

- Each conversation has one kit, so research and still can't be combined.
- Children never get `agents` or `still`.

### 8.2 Enforcement points (all are Pi seams)

1. **`configure()` [PI]** sets the offered tools and `cwd` from the kit, in the same commit as `still.grant`. Idle admission reconciles any drift. While busy, `configure` is never called.
2. **In-tool checks.** `agents`, `web_*` and `release` read `still.grant` and fail closed.
3. **`HarnessOptions.env(target)` [PI]** reads `still.grant` through `target.read` [PI]. It returns `NodeExecutionEnv` only when `kit === "still"` and `target.cwd` equals the candidate path. Otherwise it returns `undefined`.
4. **`beforeTool` hook [PI]** in `still.kernel` is a backstop and logs `tool.blocked`. Hooks only apply where their extension is selected, so this is not the primary check.

Target metadata, meaning the candidate ID and path, lives in `still.grant` and is resolved inside `env()`. There is no ExecutionTarget abstraction.

### 8.3 Grant semantics (Q3)

- **One value:** the kit, plus a target when the kit is `still`.
- **Change:** in a single Pi commit:
  1. read `LiveDoc` and `InboxDoc` [PI];
  2. if either is non-empty, return 409;
  3. otherwise write `still.grant`, call `configure`, and append `still.kit-change`.

  Pi serializes commits, so this check is atomic (README:80). A test (§17) proves it.
- **Revoke:** switch to `chat`. To stop work mid-run, use Stop, then switch.
- **The model cannot change kits.**
- **New conversations start in chat.** `fork: "initial"` makes every fork, branch and child begin in `chat` with no target.
- **Branches.** The branch endpoint also calls `configure` (chat tools, `cwd: null`) in the fork commit. `pi.agent` is rewindable and would otherwise carry over the parent's tools and cwd.
- **Children.** In the same commit as creation, the kit is set no higher than the parent's.
- **Single writer.** Only the kit endpoint and child creation write `still.grant`. A source-scan test checks this.

### 8.4 Execution boundary in v1 (Q7, honest)

`still`-kit tools run through `NodeExecutionEnv` as the **`_still`** macOS user, inside the app process tree.

**They can:**
- read and write the app database;
- read the app's environment and memory through the same-user process tools: provider keys and `STILL_INTERNAL_TOKEN`;
- use the network;
- read and write other candidates.

**They cannot:**
- read Ron's home directory, **provided** `_still` has its own primary group (`_still`, not `staff`) and `/Users/<owner>` stays `drwxr-x---` (true on this Mac today: `<owner>:staff 750`). The installer creates the group and checks the mode. If `_still` were in `staff`, it could read `~/code`, `~/notes` and dotfiles. `~/.ssh` and `~/Documents` are 700 either way;
- write releases, which are root-owned and read-only;
- read `host.env` (root, 0600);
- activate a release, which needs a passkey assertion on the approval origin.

`validate` runs the candidate's tests and build with the same `_still` authority.

**[DEFERRED] containment.** It plugs in through the **same `env()` seam**: a custom `ExecutionEnv` with a stable `id`. Options:
- **Linux:** a separate `still-exec` user plus bubblewrap (no network, private `/proc`).
- **macOS:** a separate user plus `sandbox-exec` profiles, or a Linux micro-VM.
- **Cloudflare:** no shell.

Threat probes T1–T3 (§17) are recorded as known failures until then.

**The preview has the same authority.** In v1 the preview also runs as `_still`. Its isolation is **origin and configuration only**: a separate port and origin, a scratch database and no keys in its environment. A hostile preview release has the same process authority as the app: it can read the live database and the app's environment. This holds until containment lands.

---

## 9. Agents and reports [STILL on PI]

### 9.1 `agents` tool

`replay: "safe"` [PI]. The foreground pattern follows Pi example 22; the background pattern follows example 23. The difference is report delivery (§9.4).

| Action | Args | Result |
|---|---|---|
| `spawn` | `{tasks: [{prompt, model?}] (1–5), context: "fresh" \| {forkAt}, kit, mode: "foreground" \| "background", auto?}` | foreground: reports. background: `{batch}` |
| `message` | `{batch, index, text, whenBusy}` | ack |
| `stop` | `{batch, index?}` | ack |
| `list` | `{}` | batches |

**Structural limits (not budgets):**
- at most 5 children per spawn;
- children can't spawn;
- children never get the still kit.

### 9.2 `Batch` (in `still.agents`)

```ts
type Batch = {
  id: string; requestId: string; mode: "foreground" | "background";
  kit: "chat" | "research"; cutoff: EntryId | null; auto: boolean; createdAt: number;
  children: { index: number; attempt: number; conversationId: ConversationId; model: string;
              status: "running" | "completed" | "failed" | "cancelled"; answerEntry?: EntryId }[];
  state: "open" | "settled" | "consumed";
};
```

**A report is a projection [STILL], not a stored copy:**

```text
report = {
  model, status,
  answer:    pi.assistant entry at answerEntry (immutable [PI]),
  citations: from that child's web_fetch tool results,
  usage:     child pi.usage
}
```

Recording `answerEntry` at settle time keeps reports immutable, even if the child conversation is continued later.

### 9.3 Ownership [PI]

| Mode | Child owned by | Stop | Stop agents |
|---|---|---|---|
| foreground | `still.agent-run` under the tool task | aborts | — |
| background | `still.agent-anchor` (`background: true`) | not reached | aborts |

A retry creates a new child from the same cutoff, with `attempt + 1`.

### 9.4 Delivery (Q2: simplest sensible)

**Foreground.** The tool result contains the reports, and the parent answers in the same run.

**Background**
- Report rows appear on the batch card. They are **not** in the model's context.
- When the batch settles, one push is sent.
- **Consume** happens once per batch, either by tap or by `auto`. It is a single `followUp` submission [PI]:
  - it contains all of the batch's reports, each fenced as untrusted content;
  - its `requestId` is `consume:<batch>` (Pi request-ID dedupe [PI]).

  A second consume is a no-op.
- **Loop breaker:** a run started by a consume can't spawn a batch with `auto: true`.

---

## 10. Dependency architecture, the kernel, extensions, and seams

### 10.1 Dependency graph [TARGET]

```diagram
┌──────────────────────────── src/client (React PWA) ────────────────────────────┐
│ chats · conversation · composer · work · cards           (evolvable)          │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ HTTP + SSE (watch ops)
┌───────────────────────────────▼───────────────────────────────────────────────┐
│ src/server  (routes, chat service)                       (evolvable)          │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────────────┐
│ src/kernel  [STILL, protected]                                                │
│  kits.ts · env.ts · agents.ts · research.ts · release-tool.ts · push.ts       │
│  seams: SearchProvider · Notifier · ReleaseHost (client side)                 │
└───────────┬───────────────────────────────┬───────────────────────────────────┘
            │ uses directly                 │ calls (loopback, internal token)
┌───────────▼──────────────────────┐ ┌──────▼──────────────────────────────────┐
│ @earendil-works/pi-durable 1.0.2 │ │ src/host  supervisor  [STILL, protected] │
│ Harness · Storage · env() ·      │ │ ReleaseHost impl · approval origin ·     │
│ tasks · tools · hooks · docs ·   │ │ platform fns (mac | linux)               │
│ watch · taskGraph · usage        │ └──────┬──────────────────────────────────┘
└───────────┬──────────────────────┘        │
            │                               │
┌───────────▼───────────────────────────────▼───────────────────────────────────┐
│ deploy/mac  (launchd plists, tailscale serve, backup script, install.sh)       │
│ deploy/linux, deploy/cloudflare  — later, only when built                      │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Rules**
- The kernel imports Pi directly.
- Nothing above the kernel imports the host.
- Deploy code is scripts and configuration with no TypeScript interfaces (D13).

### 10.2 The only Still interfaces [STILL]

| Interface | Why it's warranted | v1 implementation | Later implementations |
|---|---|---|---|
| `SearchProvider { search(q) → {title,url,snippet}[] }` | The provider choice is open, tests need a fake, and Cloudflare needs fetch only | Brave (HTTP) | Others; a fake in tests |
| `Notifier { notify(kind, conversationId) }` | Tests need a fake. Node and Workers need different Web Push crypto. The payload rule is enforced in one place: no transcript content. | Web Push (VAPID) on Node | Workers WebCrypto Web Push |
| `ReleaseHost` (§12.2) | It is the trust boundary, and its implementations really differ (Mac/Linux supervisor vs Cloudflare versions) | Mac supervisor | Linux supervisor (mostly shared code); Cloudflare Workers versions (no candidates) |

**Explicitly no interface for:**
- Storage, env, scheduling or recovery, which come from Pi;
- Tailscale, launchd, systemd, backups or provisioning, which are deploy scripts.

### 10.3 Extension tiers

| Tier | Contents | Change path |
|---|---|---|
| Kernel | `src/kernel/**`, `src/host/**`, manifests, Pi wiring | Operator release only |
| Extensions | `extensions/<name>.ts` via `defineStillExtension` → `defineExtension` [PI] | still kit → release → Face ID → restart |
| Data (Phase 5) | Skills, notes, presets | Edited live, no authority |

**Manifest:** `{name, kits, network?, secrets?, tools}`.

**Extensions cannot:**
- add kits or hooks;
- replace the reserved tools: `read`, `write`, `edit`, `bash`, `agents`, `web_search`, `web_fetch`, `release`;
- write `still.grant`.

**Loading:** only when a release starts, through `registry.install` [PI]. A failed import fails readiness, which triggers rollback.

**Protected paths:**
- `src/kernel/**`
- `src/host/**`
- `src/shared/contracts.ts`
- `package.json`, `package-lock.json`
- `tsconfig.json`, `oxlint.config.ts`, `vite.config.ts`
- any file named like a migration

---

## 11. Research and attachments [STILL]

### 11.1 Threat

The research kit holds private data, untrusted pages, and outbound fetch. Together these are the "lethal trifecta".

### 11.2 Safety controls (safety rules, not research limits)

**SSRF guard**
- Pin the DNS resolution to one IP.
- Deny loopback, `0/8`, RFC1918 ranges, `169.254/16`, `100.64/10` (the tailnet, which **includes the Mac's own tailnet IP**), `fc00::/7`, `::1`, IPv4-mapped forms, and metadata addresses.
- Re-check every redirect.
- Allow only `http` and `https`.

**URL provenance**
- `web_fetch` proceeds without asking only if the URL appears in the **visible transcript**. That covers user entries, attachment text, `web_search` tool results, `still.fetch-confirm` allow entries, and extension network allowlists.
- The scan uses the tool's context and entry reads [PI]; nothing extra is stored.
- Any other URL returns `needs_confirmation` and shows a card.

**Fencing**
- All external text is wrapped in `<untrusted …>`.
- No tool can change kits.

### 11.3 No limits (Q6)

- There are no caps on count, size, results or redirects, other than loop detection.
- A 60 s idle-socket timeout guards against hung connections. It is not a size limit.
- Content that overflows the model's context window shows up as a failed tool line.

### 11.4 Search, extraction, citations, attachments

- **Search:** `SearchProvider` → Brave. Results become `web_search` tool-result entries, which count toward provenance.
- **Extraction:** Readability for HTML; pdf.js for PDFs.
- **Citations:** numbered `[n]`, each with `{url, title, fetchedAt}`.
- **Attachments:**
  - images: downscaled to 1600 px and stored inline as `ImageContent` [PI];
  - PDFs: the full text is extracted, fenced and stored inline; the original goes to `data/attachments/<sha256>.pdf`;
  - text files: fenced and stored inline.

### 11.5 Development models (Q6)

- **Tests:** the faux provider only.
- **Smoke tests:** the newest free OpenCode Go model, verified as current. Otherwise the cheapest configured model. Never fall back to a paid model without approval.
- **`STILL_DEV_MODEL`** sets the default model for dev.

---

## 12. Self-modification: the ReleaseHost contract and the trust chain

### 12.1 Keep [NOW]

- positive source allowlist;
- staged-byte gates with a before/after hash;
- dependency and persistence rejection;
- immutable, content-addressed, root-owned releases;
- a preview with its own database and no keys, returning 410 once stale;
- rejection of candidates built on a stale base;
- journal recorded before stop;
- activation only after readiness passes;
- automatic rollback, crash recovery, the 2 s monitor, and refusal of a second supervisor.

### 12.2 `ReleaseHost` contract [STILL]

One contract with two audiences. The split is the security property.

```ts
// App-facing: callable by the kernel with the internal token over loopback.
interface ReleaseHostApp {
  capabilities(): { candidates: boolean; preview: boolean };     // Cloudflare: candidates=false
  createCandidate(requestId: string): Promise<{ id: string; path: string }>;
  validate(candidateId: string): Promise<{ digest: string; checks: CheckSummary; previewUrl: string }>;
  status(): Promise<{ active: string; previous?: string; pending?: string; lastOutcome: string }>;
}
// Owner-facing: served only on the approval origin, gated by a WebAuthn assertion. Never callable with the internal token.
interface ReleaseHostOwner {
  card(candidateId: string): Promise<ReleaseCard>;               // supervisor-computed data only
  challenge(candidateId: string, digest: string): Promise<Challenge>;
  activate(candidateId: string, digest: string, assertion: Assertion): Promise<Outcome>;
  rollback(to: string, assertion: Assertion): Promise<Outcome>;
}
```

| Implementation | candidates | preview | activate / rollback |
|---|---|---|---|
| Mac supervisor (v1) | Copy of the active release under `_still` | `127.0.0.1:3100` → `:8443` | Restart the app on a release, journal, auto-rollback |
| Linux supervisor (later) | Same code; `still-exec` + bubblewrap | Same | Same; systemd instead of launchd |
| Cloudflare (later) | **None**: no shell, no self-edit. Releases are built outside (CI) and uploaded as Worker versions. | Worker version preview URL | Gradual-deployment promote / rollback, gated by the same passkey flow |

### 12.3 Changes [TARGET]

| # | Change |
|---|---|
| R1 | Builder mode is replaced by the still kit. `builder.tsx`, `/api/builder/chat` and `still.builder` are deleted. |
| R2 | Baseline acceptance (§12.4) |
| R3 | Preview gets its own origin (`:8443`). Mutating app routes require `Content-Type: application/json` plus `X-Still-Client: 1`. No CORS headers are sent. |
| R4 | Approval gets its own hostname and uses WebAuthn. **The app origin sets no cookies.** |
| R5 | The owner token works for loopback recovery only. |
| R6 | A database snapshot is taken before every activation. |
| R7 | Retention: active, previous, and the 3 newest releases. Candidates and previews older than 14 days are deleted. |

### 12.4 Baseline acceptance

The baseline lives in `/usr/local/still-host/baseline/` (root-owned, outside every release).

1. Pinned `tsconfig`, `oxlint` and `vite` configs overwrite the staged copies. Then `tsc`, `oxlint` and `vite build` run.
2. The candidate's own `vitest` must pass.
3. Boot on a scratch database with the faux provider and run `smoke.ts`:
   - chat stream;
   - reload and list;
   - chat kit can't use `web_fetch`;
   - chat kit `bash` has no env;
   - research fetch to `127.0.0.1` is rejected;
   - `/healthz` reports the digest and extensions;
   - SSE reconnects.

In v1 these steps run as `_still`. The baseline stops criteria from being weakened by accident. It does not contain hostile code.

### 12.5 Passkey approval and enrollment

The RP ID is `still-approve.<tailnet>.ts.net`, so app-origin code can't ask for assertions. Assets are served from `/usr/local/still-host`.

**Enrollment**
1. `sudo still-host enroll` prints a one-time 8-digit code, valid for 15 minutes, to the host log.
2. Enter the code on the iPhone at the approval origin, then Face ID.
3. The credential is stored in `owner.json` (root, 0600).
4. A signed-in session can add more passkeys.
5. `still-host enroll --reset` clears them.

**Approve**
1. Card.
2. Challenge `{candidateId, digest, exp 5 min}`.
3. Face ID.
4. `activate`.

The supervisor verifies the assertion and its binding, that the digest equals the validated release, and that the base equals the active release.

**Library:** `@simplewebauthn/server` and `@simplewebauthn/browser`. Adding them is a dependency change, so it ships as an operator release.

### 12.6 Trust chain

```diagram
┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ┌─────────────┐  ┌───────────────┐
│ still kit  │─▶│ staged bytes │─▶│ pinned base- │─▶│ immutable     │─▶│ preview     │─▶│ approval card │
│ edits cand.│  │ + gates      │  │ line + smoke │  │ release (root)│  │ :8443       │  │ (supervisor)  │
└────────────┘  └──────────────┘  └──────────────┘  └───────────────┘  └─────────────┘  └───────┬───────┘
                                                                                               │ Face ID over
┌──────────────┐  readiness fail  ┌──────────────┐                                             │ {candidate,digest}
│ auto rollback│◀─────────────────│ activate     │◀────────────────────────────────────────────┘
└──────────────┘                  └──────────────┘
```

---

## 13. Deployment: native Mac mini v1; Linux and Cloudflare later

### 13.1 Topology (v1) [TARGET]

```diagram
┌────────────────────────────── Mac mini (macOS 26, M4 Pro, 24 GB) ──────────────────────────────┐
│ launchd                                                                                         │
│  /Library/LaunchDaemons/dev.still.host.plist    root  KeepAlive  → node supervisor             │
│        └─ spawns app release  (user _still)  127.0.0.1:3000                                     │
│        └─ spawns preview      (user _still)  127.0.0.1:3100                                     │
│        └─ approval server     (root)         127.0.0.1:3200                                     │
│  /Library/LaunchDaemons/dev.still.backup.plist  root  03:30 daily → backup.sh                   │
│ Tailscale (existing node)                                                                       │
│  serve https://still.<tn>.ts.net        :443  → 127.0.0.1:3000                                  │
│  serve https://still.<tn>.ts.net        :8443 → 127.0.0.1:3100                                  │
│  serve https://still-approve.<tn>.ts.net :443 → 127.0.0.1:3200   (Tailscale Service — P-01)     │
│ /usr/local/still-host (root)   /Library/Application Support/Still (state)   Time Machine        │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 13.2 Layout and identities (Q5 defaults)

| Path / identity | Owner, mode | Contents |
|---|---|---|
| User `_still` (hidden, UID < 500, **own primary group `_still`, not in `staff`**, no login shell, created with `dscl`) | — | Runs the app and preview. **Never Ron.** A Ron-owned app would give the uncontained still kit Ron's whole home directory. The installer asserts `id -Gn _still` excludes `staff` and that `/Users/<owner>` is mode 750 or stricter. |
| `/usr/local/still-host/` | root, 0755 | Supervisor source at the operator's chosen commit, `node_modules`, `baseline/`, approval UI |
| `/usr/local/still-host/node/` | root | Pinned Node 26.10.0 from the official tarball. **Not Homebrew**: `/opt/homebrew` is user-writable, and a root daemon must not execute user-writable binaries. |
| `/Library/Application Support/Still/secrets/host.env` | root, 0600 | Provider keys, `BRAVE_API_KEY`, VAPID keys, `STILL_DEV_MODEL`, extension secrets |
| `…/Still/releases/<sha>` | root, read-only | Immutable releases |
| `…/Still/candidates/`, `…/Still/data/`, `…/Still/previews/` | `_still` | Candidates, live database and attachments, preview databases |
| `…/Still/backups/`, `journal.json`, `owner.json` | root | Supervisor state and backups |
| `/Library/Logs/Still/{host,app}.log` | root | launchd stdout/stderr, rotated by `/etc/newsyslog.d/still.conf` |

### 13.3 Tailscale

- The Mac is already a tailnet node (`CertDomains: None` today).

**Ron's actions**
1. Enable HTTPS certificates.
2. Enable Tailscale Services and create `svc:still` and `svc:still-approve`, if Services are available on his plan (P-01).
3. Add an ACL restricting both services to his devices.

**Supervisor check:** it requires the `Tailscale-User-Login` header to be Ron's login (P-02).

**Fallback if Services aren't available**
- Use the Mac's own node name for the app and preview.
- Run a second `tailscaled` in userspace mode for `still-approve`:
  - from the open-source build, owned by root;
  - with `--tun=userspace-networking --statedir=…/tailscale-approve`;
  - under its own LaunchDaemon.

**No Funnel.**

### 13.4 Supervisor portability: platform functions, not adapters

`src/host/platform.ts` has two functions, selected by `process.platform`:
- `processStartTime(pid)`:
  - Linux: `/proc/<pid>/stat`;
  - macOS: `ps -o lstart= -p <pid>`, parsed.
- `killAllOf(uid)`:
  - Linux: a `/proc` scan;
  - macOS: `pkill -KILL -U <uid>`.

**Root check.** `process.getuid() === 0`, and the app UID must differ. This is unchanged, but the message changes from "Linux supervisor" to "supervisor".

**Units.** launchd on macOS. A systemd unit is added only when Linux is built.

### 13.5 Install and upgrade (deploy code, no interfaces)

- **`deploy/mac/install.sh`** (run with `sudo`). It:
  1. creates `_still`;
  2. installs Node into `/usr/local/still-host/node`;
  3. clones the commit and runs `npm ci`;
  4. creates the directories and their permissions;
  5. writes the plists and the newsyslog config;
  6. runs `launchctl bootstrap system …`;
  7. configures `tailscale serve`;
  8. prints the URLs and the enrollment code.
- **`sudo still-host operator-release <commit>`.** It:
  1. fetches the commit;
  2. runs `npm ci`;
  3. runs the baseline against the active release;
  4. takes a backup;
  5. restarts the daemon with `launchctl kickstart -k system/dev.still.host`.
- **Every phase ships this way.**

### 13.6 Portability (later adapters)

| Layer | Mac v1 | Linux (later) | Cloudflare (later) |
|---|---|---|---|
| Pi Storage | `openNodeSqliteStorage` | Same | `SqliteStorage.open(<DO sqlite facade>)` (README:529) |
| Harness host | Node process | Node process | One Durable Object per owner. **Caveat:** after eviction, `harness.resume()` must be called again on the next fetch or alarm. This is a ~10-line DO hook, not a WakeScheduler. |
| `env()` | `NodeExecutionEnv` (still kit) | bubblewrap `ExecutionEnv` | `undefined` (no shell). An `ExecutionEnv` over a remote container is possible later. |
| Kits | chat, research, still | chat, research, still | **chat, research only** |
| ReleaseHost | Mac supervisor | Linux supervisor | Workers versions + passkey; no candidates |
| Notifier | Web Push on Node | Same | Web Push with WebCrypto |
| Access | Tailscale serve | Tailscale serve | Cloudflare Access, or Tailscale to an origin |
| Ops | launchd, newsyslog, Time Machine | systemd, journald | wrangler, D1/R2 backups |

**Capabilities are not equal.** Cloudflare gives up the still kit, so it has no self-modification from the phone. The approval and rollback contract holds everywhere.

---

## 14. Cutover (no migration, Q4)

- **Phase 0** deploys `5755703` on the Mac mini to dogfood it.
  - The current supervisor is Linux-only, so Phase 0 runs the plain app as `_still` under launchd. It does not run the supervisor.
  - The app runs with `npm run build` and `node --import tsx src/server/main.ts`, with `STILL_DATABASE` under `/Library/Application Support/Still/data`.
  - Builder is not available in Phase 0.
- **Phase 1:**
  - deletes the Arena, Builder and audit code;
  - lands `platform.ts` so the supervisor runs on macOS;
  - starts on a **fresh** database.
- The dogfood database is archived as `backups/phase0-final.sqlite`.
- Only `still.chat` (now just `{title}`) and `still.extension.<name>` survive as identifiers.

---

## 15. Phased implementation

**Rules**
- Each phase is built test-first on a local branch and shipped as an operator release.
- Each phase is gated by §16.
- **Nothing is pushed to the public repository without Ron's approval.**
- Separate worktrees are used for parallel workers.

| Phase | Builds |
|---|---|
| **0 — Live and dogfood** | `_still` user; pinned Node; the app (not the supervisor) under a LaunchDaemon on `127.0.0.1:3000`; `tailscale serve`; backup plist; restore drill. One week on a real iPhone. |
| **1 — Kernel, kits, shell** | Delete Arena, Builder and audit; fresh database. `src/host/platform.ts` lets the supervisor run on macOS via launchd. `src/kernel/{harness,kits,env,admission,prices,push}.ts`; `still.kernel`; kit and model endpoints; steer/queue; fork-based branch; cost chip; `Notifier` (Web Push); client split; protected set; `deploy/mac/install.sh`. |
| **2 — Research and attachments** | `src/kernel/{fetch,search,extract}.ts`; `SearchProvider` (Brave); provenance by transcript scan; fetch-confirm; citations; uploads |
| **3 — Agents** | `src/kernel/agents.ts` (the tool and three tasks); report projection; batch card; consume; Work tab from `watchTaskGraph` |
| **4 — Self-modification (completes v1)** | **4a** baseline and pinned configs. **4b** preview origin, CSRF header, approval hostname, WebAuthn, enrollment, loopback-only token, no app cookies. **4c** still kit, `release` tool, `ReleaseHostApp` client, release card, retention, pre-activation snapshot. |
| **5 — Data tier (v1.1)** | Skills and notes (session docs) injected through `beforeRequest` [PI] |
| **Deferred** | Containment via a custom `ExecutionEnv`; Linux adapter; Cloudflare adapter; Workbench; schedules (tasks with `runtime.sleep` [PI]); native shell; Pi upgrade |

---

## 16. Acceptance criteria

**Phase 0**
- The iPhone, in Safari and as an installed PWA, reaches `https://still.<tn>.ts.net` and chats.
- The app runs as `_still`: `ps -o user= -p <pid>`.
- Lock/unlock reconnects.
- The backup ran, and a restore boots.
- After a Mac reboot, Still comes back without a login.
- A week of dogfooding is logged.

**Phase 1**
- Fresh database; no Arena or Builder code.
- The supervisor runs on macOS, and its crash, recovery and rollback tests pass there.
- Changing the kit while busy returns 409.
- Chat kit:
  - `web_fetch` is not offered and fails closed;
  - `bash` gets no env.
- A model change shows as an entry. Steer joins the running turn.
- Retry produces a fork in the chat kit, with a parent link from `ConversationRecord.parent`.
- The cost chip equals `pi.usage` × price.
- A push arrives with no content.
- `npm run check` is green.

**Phase 2**
- Photo Q&A works.
- A PDF summary cites its source.
- A research answer has ≥2 `[n]` citations.
- T11–T13 pass.

**Phase 3**
- A foreground compare returns in one run.
- A background batch produces 3 rows, 1 push, and 0 parent inferences until consumed.
- A consume happens exactly once across tap, `auto` and a SIGKILL.
- A 6th child is rejected.
- No child gets `agents` or the still kit.

**Phase 4**
- T5–T10 pass.
- The weather-tool demo works end to end with Face ID.
- A forced readiness failure rolls back automatically.
- A Face ID rollback works.
- The token is rejected off-loopback.
- Enrollment and reset work.

**Phase 5**
- A skill changes the next turn without a release.
- Undo works.
- A skill adds no tools.

---

## 17. Tests and threat probes

### 17.1 Automated (Vitest, faux provider, `MemoryStorage` or a temp SQLite [PI])

| File | Covers |
|---|---|
| `test/kernel/kits.test.ts` | Default chat; 409 when busy or the inbox is non-empty (P-05); one-commit change; single-writer source scan; idle reconcile; a busy steer is not reconciled |
| `test/kernel/env.test.ts` | `env()` returns `undefined` for chat and research; `NodeExecutionEnv` only for still with a matching cwd |
| `test/kernel/branch.test.ts` | `fork(at)` at the right entry; `ConversationRecord.parent` is set; a fork from still is chat with no cwd or tools |
| `test/kernel/fetch.test.ts` | SSRF set, including the Mac's tailnet IP; redirect to a private IP; DNS rebinding blocked by IP pinning; provenance from transcript; confirm; no size cap |
| `test/kernel/agents.test.ts` | Foreground result; background `answerEntry` recorded once across restarts; one push; consume once (tap, auto, SIGKILL); loop breaker; 5-child cap; child kit ≤ parent; retry |
| `test/kernel/push.test.ts` | Fake `Notifier`; payload has no transcript text |
| `test/host/platform.test.ts` | `processStartTime` and `killAllOf` on darwin (and linux in CI later) |
| `test/host/release.integration.test.ts` | Existing release, rollback and recovery coverage, plus baseline, preview origin, approval binding and enrollment |
| `/usr/local/still-host/baseline/smoke.ts` | §12.4 |

### 17.2 Threat probes (on the Mac at phase gates)

| # | Threat | Probe | v1 expected | Phase |
|---|---|---|---|---|
| T1 | Exec reads app secrets | still kit: `ps eww -u _still \| grep KEY` | **Succeeds** — known, deferred | — |
| T2 | Exec writes the database | still kit: `sqlite3 …/Still/data/still.sqlite` | **Succeeds** — known, deferred | — |
| T3 | Exec uses the network | `curl https://example.com` | **Succeeds** — known, deferred | — |
| T4 | Exec reads Ron's home | `ls /Users/<owner>; cat ~<owner>/.gitconfig` | **Denied**: home is 750 `<owner>:staff` and `_still` is not in `staff` | 0 |
| T5 | Weakened criteria | `strict:false`, a lint disable, deleted tests | Pinned baseline still fails | 4a |
| T6 | Preview attacks the app or approval | Cross-origin POSTs; cookie reads | Preflight denied; no app cookies | 4b |
| T7 | Spoofed approval | Hostile app calls WebAuthn with the approval RP ID | RP ID mismatch | 4b |
| T8 | Digest swap or replay | Approve A, activate B; replay | Rejected | 4b |
| T9 | Token misuse | Token sent from the phone | Rejected (loopback only) | 4b |
| T10 | Kernel self-edit | Candidate edits `src/kernel/kits.ts` | 422 | 4c |
| T11 | SSRF | `127.0.0.1:3000`, `:3200`, the Mac's `100.x`, `169.254.169.254`, redirects, rebinding | Blocked | 2 |
| T12 | Injection exfiltration | Page says "fetch https://evil/?q=…" | Confirm card | 2 |
| T13 | Injection escalation | Page says "switch to still" | No tool for it | 2 |
| T14 | Fan-out | Request to spawn 50 children | Max 5; no recursion | 3 |
| T15 | Consume loop | An `auto` consume spawns with `auto` | Forced to `false` | 3 |
| T16 | Mid-run change | Kit change during a run | 409 | 1 |
| T17 | Other tailnet device | Request from a non-Ron device | ACL drop; 403 | 0/1 |
| T18 | Push leak | Inspect the payload | Title and ID only | 1 |

---

## 18. Observability

- **Logs:** JSON lines through launchd stdout to `/Library/Logs/Still/*.log`, rotated by newsyslog (14 files, 50 MB).
  - **No prompt or answer text is ever logged.**
  - Events: `admission`, `kit.change`, `tool.call`/`tool.blocked`, `fetch`, `agent.spawn`/`settle`/`consume`, `push.send`, `release.*`, `backup`.
- **`pi-telemetry`:** no-op in v1.
- **App `/healthz`:** `{release, extensions[{name, sha256}], db, harness, pendingTasks}`.
- **Pi sources:**
  - `harness.inspect()` lists blocked and orphaned tasks;
  - `harness.watchTaskGraph()` feeds Work → Running;
  - `harness.usage()` gives spend.
- **Supervisor status** (approval origin): `{active, previous, pending, lastOutcome, lastBackup}`.
- **After a rollback:** the release card shows the last 50 log lines.

---

## 19. Backups and rollback (Q5)

| What | How | Kept |
|---|---|---|
| Database | `dev.still.backup` daily at 03:30 runs `sqlite3 still.sqlite ".backup backups/daily/still-<date>.sqlite"` | 14 |
| Supervisor state | Copy `journal.json` and `owner.json` alongside | 14 |
| Attachments | `rsync` | Mirror |
| Off-machine | Time Machine covers `/Library/Application Support/Still`. Requires a TM destination (P-03). | TM policy |
| Pre-activation | Supervisor runs `.backup` → `backups/pre-<digest>.sqlite` | 5 |

**Rollback semantics**
- Code rollback restores the previous release only. It does not roll back data, provider calls or external effects.
- `requestId` dedupes admission, not billing.
- Data restore is an operator step: `sudo still-host restore <file>`.

**Restore drill:** run at every phase gate.

---

## 20. Non-goals (v1)

- Containment or sandbox claims. Spending budgets. Research limits. Migration or compatibility code.
- Wrapper abstractions over Pi, including DurableStore, ExecutionTarget and WakeScheduler, and interfaces over ops tooling.
- A VM or Linux-first deployment. Cloudflare in v1. Cloudflare self-edit or shell at all.
- Multiple users, public exposure, or a native app.
- Workbench; repo, remote or browser targets.
- Recursive agents. Still-kit children. Partial consumption of results.
- Hot reload. Extension hooks. A marketplace.
- Kernel, dependency or schema self-edits. Auto-activation.
- Arena judging. Hidden memory. Schedules. Voice.
- A Pi upgrade during the pivot.

---

## 21. Blockers, probes, accepted risks

### 21.1 Needs Ron

| # | Item | Blocks |
|---|---|---|
| B1 | Approve the native install: the `_still` user, root LaunchDaemons, and Node under `/usr/local/still-host` | Phase 0 |
| B2 | Tailscale admin: enable HTTPS certificates; enable Services and create `svc:still` and `svc:still-approve` (or approve the userspace-node fallback); apply the ACL | Phase 0 (approval host by Phase 4) |
| B3 | The repo is public. Push this spec and the pivot work publicly, or make the repo private first? | Any push |
| B4 | A Brave Search API key (or another provider) | Phase 2 |

### 21.2 Probes

| # | Probe | Fallback |
|---|---|---|
| P-01 | Tailscale Services can serve `still-approve` from this Mac | A second userspace `tailscaled` under its own LaunchDaemon |
| P-02 | `tailscale serve` sends `X-Forwarded-Proto: https` and `Tailscale-User-Login` | A host flag to trust the serve hop; rely on the ACL alone |
| P-03 | LaunchDaemons start after a reboot with no login; Time Machine has a destination | Enable auto-login; external backup target |
| P-04 | iOS Web Push from a ts.net PWA | Work-tab badges |
| P-05 | Reading `LiveDoc` and `InboxDoc` inside the kit commit is atomic | Expected from README:80 (one line of commits). Proven by `kits.test.ts`; fallback is a per-conversation mutex. |

### 21.3 Accepted risks

- No exec containment (Q7). `_still` can read keys and read/write the database. It cannot read Ron's home directory, as long as the group and mode conditions in §13.2 hold.
- The preview has the same authority as the app in v1. Its isolation is origin and configuration only.
- No spending caps (Q1). No research limits (Q6).
- Leaks through search queries or confirmed URLs.
- An approved malicious release can read keys.
- Untested effect of compaction on forks.
- Pi is "Experimental", so the pin is mandatory.
- A crash retry can bill a provider twice.
- Phase 0 dogfood data is discarded (Q4).
- A Mac mini is a single machine, with no HA.

---

## 22. ADRs

Each ADR lists its decision, its status, and its consequences.

| ADR | Decision | Status | Consequences |
|---|---|---|---|
| 01 Native Mac mini v1 | Root LaunchDaemon supervisor; app as `_still`; localhost; pinned root-owned Node; no VM | Ron (D1) + Default details | `platform.ts` replaces the `/proc` code. Linux comes later. |
| 02 Tailscale-only HTTPS | `tailscale serve` on the existing node; Services for the approval host; ACL; `Tailscale-User-Login`; no Funnel | Ron (D2) | Depends on P-01/P-02 |
| 03 Trusted owner; containment deferred | No exec containment in v1; the same `env()` seam later | Ron (D3, Q7) | T1–T3 are known failures; T4 is denied by macOS user separation |
| 04 Pi primitives directly | Storage, `env()`/`ExecutionEnv`, tasks/`sleep`/waits, ownership, tools/hooks/extensions, docs/entries, submissions, forks, watch/taskGraph/inspect/usage, `resume` | Ron (D11) | DurableStore, ExecutionTarget and WakeScheduler are deleted. Four `still.*` docs/entries are dropped (§7.4). |
| 05 Kit as one tiny doc | `{kit, target}`; idle-only change; revoke by switching to chat; forks start in chat | Ron→Default (Q3) | Enforced via `configure`, in-tool checks, `env()`, and a hook |
| 06 Report as projection | Pointer to the child's `answerEntry` + `pi.usage`; one consume per batch | Ron→Default (Q2) | No report copies; immutable by construction |
| 07 ReleaseHost, split by audience | App: candidate/validate/status. Owner: card/challenge/activate/rollback behind a passkey. | Ron (D8, D12) | One contract; Cloudflare reports `candidates: false` |
| 08 Only two provider seams | `SearchProvider`, `Notifier` | Ron (D12) | Ops stays in `deploy/` scripts |
| 09 Pi pinned at 1.0.2 | Upgrade later as its own release | Ron (D10) | No 1.1 features (e.g. `registerEnvConformance`) |
| 10 Retry/edit = `fork(at)` | Branch link from `ConversationRecord.parent` | Default | No `still.branch` |
| 11 Builder becomes the still kit | `/build`; card in chat; approval off-origin | Ron (D9) | Builder UI deleted |
| 12 Arena becomes `agents` | Pi examples 22/23 patterns | Ron (D6) | 128k synthesis path deleted |
| 13 No migration | Fresh database at Phase 1 | Ron (Q4) | Dogfood archived |
| 14 Small protected kernel | §10.3 list | Default | UI and extensions can evolve |
| 15 No budgets | Display only; structural caps | Ron (Q1) | Accepted risk |
| 16 No research limits; cheap dev models | Faux in tests; free Go models for smoke | Ron (Q6) | — |
| 17 Portability via Pi seams | Linux = new `ExecutionEnv` + systemd. Cloudflare = DO `SqliteDatabase` facade + `resume` hook, no still kit. | Ron (D14) | Honest capability gap |
| 18 Model change between runs; Chats \| Work tabs; no push content; inline attachments | — | Default | — |

---

## 23. Evidence

All line references were checked against `main` @ `5755703`. Every Pi Durable claim in §3.3 was checked by exact-string grep against `@earendil-works/pi-durable` 1.0.2 (`dist/*.d.ts`, README). `registerEnvConformance` does not exist in 1.0.2. Not yet verified: the macOS replacements for the supervisor's `/proc` code, and probes P-01 to P-05.
