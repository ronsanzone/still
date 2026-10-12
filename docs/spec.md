# Still: product and architecture

Status: current as of 2026-10-11 (the "remote agent" pivot). This replaces the
v1.2 rearchitecture spec and the original design doc. Their kit, URL-gating and
release-supervisor designs were removed; see "Decisions".

## What Still is

Still is Ron's remote agent. It runs on his Mac mini, is used mostly from an
iPhone over Tailscale, and has full capabilities: it reads and writes files,
runs shell commands and searches and reads the web. You send it work, lock the
phone, and come back to the result.

It is closer to Pi Pocket and Amp's orbs than to a chat app. The difference
from Pi Pocket is that Still is its own durable server, not a viewer for a
desktop agent session.

**Pillars**

- **Owned:** your machine, your keys, your models, one SQLite file.
- **Durable:** work survives a locked phone, a closed tab and a server restart.
- **Capable:** one agent with real tools, not modes.
- **Calm:** the answer comes first; tool work is summarized and expandable;
  it interrupts only for real decisions.

**Not:** a multi-user service, a sandbox (yet) or a general chatbot.

## Architecture

```diagram
┌──────────────┐  HTTPS (tailnet only)  ┌────────────────────────────────────┐
│ iPhone / PWA │───────────────────────▶│ tailscale serve → 127.0.0.1:3000   │
└──────────────┘                        └─────────────────┬──────────────────┘
                                                          ▼
                                        ┌────────────────────────────────────┐
                                        │ Still server (Node, src/server)    │
                                        │ HTTP + SSE, Effect services        │
                                        │ Pi Durable Harness (one SQLite)    │
                                        │  ├─ model calls (keys stay here)   │
                                        │  └─ tools ─────────────┐           │
                                        └────────────────────────┼───────────┘
                                                                 ▼
                                        ┌────────────────────────────────────┐
                                        │ Workspace directory on the host    │
                                        │ (STILL_WORKSPACE); bash runs here  │
                                        └────────────────────────────────────┘
```

- **Pi Durable 1.0.2 is the substrate.** It owns conversations, entries,
  submissions (steer/queue), forks, tasks, usage, crash recovery and the task
  graph. Still never keeps a second conversation store.
- **Still adds a thin layer:**
  - `src/kernel/agent.ts`: one agent extension (read, write, edit, bash plus
    instructions) and the workspace execution environment;
  - `src/kernel/research.ts`, `search.ts`, `fetch.ts`: `web_search` (Brave) and
    `web_fetch` (Readability, pdf.js) with numbered sources;
  - `src/kernel/attachments.ts`: images, PDFs and text;
  - `src/kernel/push.ts`: Web Push (content-free hints);
  - `src/kernel/feedback.ts`: `/feedback` notes for dogfooding;
  - `src/kernel/extensions.ts`: trusted `extensions/*.ts`, loaded at start;
  - `src/server`: HTTP routes, SSE snapshots, the model catalog;
  - `src/client`: the React PWA.
- **One agent for everything.** The Harness selects every installed extension
  by default, so new chats, branches and task-owned children all get the same
  tools with no per-chat configuration.

## Tools

| Tool | What it does |
|---|---|
| `read`, `write`, `edit` | Files, relative to the workspace or absolute |
| `bash` | Shell commands in the workspace, as the Still account |
| `web_search` | Brave search; each result is a numbered source `[n]` |
| `web_fetch` | Reads a page or PDF; reuses its search number if it has one |

Extra capability comes as command-line tools the agent can call from `bash`,
or as trusted extensions in `extensions/`. There is no MCP.

## Workspace

- `STILL_WORKSPACE` (default: `workspace/` beside the database) is the working
  directory for `read`/`write`/`edit`/`bash`. It is created at start.
- It is a convention, not a boundary: commands can `cd` anywhere the Still
  account can reach.
- Later: one workspace per project, each in its own isolated box.

## Subagents (next)

The agent will be able to start child agents, in the foreground (results return
in the same run, e.g. "ask three models") or in the background (lock the phone,
get one push when the batch settles). The design is carried over from the v1.2
spec:

- an `agents` tool and three Pi tasks: `still.agent-anchor`, `still.agent-run`,
  `still.agent-batch`;
- children are Pi conversations owned by the parent (background ownership for
  background work), so Stop and "Stop agents" map to Pi aborts;
- a report is a projection over the child's answer entry plus its `pi.usage`;
- a batch card fills in as children settle; **Continue with these reports**
  consumes the batch exactly once (`consume:<batch>` request ID);
- at most 5 children per batch;
- children have the same tools as the parent (they inherit the default agent).

## Security posture (honest)

There is no isolation in this phase. Everything the agent runs, runs as the
account that runs Still.

- The agent can read and change anything that account can, including Still's
  SQLite file and its source.
- Provider keys live in the server process. Bash gets an allowlisted environment
  (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `SHELL`), so keys are not passed
  to commands. That is hygiene, not a boundary: the same account can inspect
  its own processes.
- Web pages, search results and attachments are untrusted data. They can try to
  steer the agent. The instructions say to treat them as data and to ask before
  destructive or irreversible actions, but that is a prompt, not enforcement.
- `web_fetch` still blocks private, loopback, link-local and tailnet addresses
  and pins DNS, because it runs inside the server process next to the API.
  Bash has no such guard.
- Access control is Tailscale: the app binds to loopback and is served only on
  the tailnet. There is no app login. Mutating requests require same-origin JSON
  with `X-Still-Client: 1`, which is a CSRF guard, not authentication.
- Free-model allowlist: `STILL_MODEL_ALLOWLIST` limits which models the server
  offers and accepts.

Isolation is a planned phase, not a missing afterthought; see the roadmap.

## Data

- One SQLite file (`STILL_DATABASE`, default `.data/still-v1.sqlite`) holds all
  conversations, documents, tasks, usage, push subscriptions and feedback.
- Attachment originals live in `STILL_ATTACHMENTS_DIR` (default
  `attachments/` beside the database), addressed by SHA-256.
- There is no migration framework. Breaking changes start a fresh database;
  archive the old one.

## Client

- Phone: a conversation is a full-screen view with a bottom tab bar on the root
  views (Chats, Work, Settings). Desktop: a sidebar.
- Answer first. Tool work collapses to one line per run of calls. Sources show
  what the answer cites; other results fold away.
- Streaming never auto-scrolls. A new prompt moves to the top once and the
  answer grows below it.
- The composer: attach, message, Send. While busy: Stop and Queue/Steer. Under
  it: model chip and reported cost.
- `/feedback <note>` saves a note instead of asking the model.

## Deployment

- Today: a single process on the Mac mini, bound to 127.0.0.1:3000 and exposed
  with `tailscale serve`. See `deploy/mac/README.md`.
- Next: a launchd service that survives reboot, plus scheduled SQLite backups.

## Roadmap

| Phase | Scope |
|---|---|
| Done | Durable chat, attachments, web search and fetch, push foundations, UI redesign, `/feedback`, the one-agent pivot |
| Dogfood | A week of daily use from the iPhone; triage `/feedback`; launchd service and backups |
| Subagents | The `agents` tool, batches, batch card, one push per batch, Work tab inbox |
| Isolation | Orb-style boxes: each workspace in its own lightweight VM (Apple `container` on macOS 26 is the first candidate), tools executed through Pi's `env()` / `ExecutionEnv`, keys and the database never mounted |
| Projects | One workspace per project, picked when starting a chat |
| Data tier | Skills and notes injected per turn without code changes |

## Decisions

- **2026-10-11: One full-capability agent.** Removed the Chat/Research/Still
  kits and their grant enforcement. Every chat has every tool.
- **2026-10-11: No URL provenance gating.** `web_fetch` reads any public URL.
  Search results are numbered sources; fetched pages keep their number.
- **2026-10-11: No release supervisor.** Still's own repo is ordinary agent
  work; shipping is a commit and a restart.
- **2026-10-11: Keep subagents** as the next build.
- **2026-10-11: Build without isolation first,** then add orb-style isolation as
  its own phase.
- **2026-10-11: Only offered models are accepted** (`STILL_MODEL_ALLOWLIST`).
