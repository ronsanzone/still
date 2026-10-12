# Still

Ron's remote agent: a durable, self-hosted agent with full capabilities that
runs on a Mac mini and is used mostly from an iPhone over Tailscale. Built on
**Pi Durable 1.0.2** and **Effect 4.0.0**, inspired by Pi Pocket and Amp's orbs.

Read [docs/spec.md](docs/spec.md) for the product, architecture, security
posture and roadmap.

## What it does

- One agent per chat with `read`, `write`, `edit`, `bash`, `web_search` and
  `web_fetch`. Commands run in a workspace directory on the host.
- Durable runs: lock the phone, close the tab or restart the server; work and
  transcripts survive (Pi Durable owns them).
- Streaming answers with Stop, Queue and Steer; edit or retry any prompt as a
  branch without changing the original.
- Image, PDF and text attachments. Images are downscaled in the browser; PDF
  text is extracted on the server.
- Numbered sources: search results and fetched pages are `[n]` sources the
  answer can cite; the Sources panel shows what was cited.
- Web Push (content-free) once VAPID keys are configured; see
  [docs/push-setup.md](docs/push-setup.md).
- `/feedback <note>` saves a dogfooding note (Settings → Feedback,
  `GET /api/feedback`).
- Chats, Work (live Pi task graph) and Settings, as a PWA with light and dark
  themes.

## Security posture

**There is no isolation yet.** The agent runs commands as the account that runs
Still, so it can read and change anything that account can, including Still's
database and source. Provider keys are not passed to `bash`, but that is not a
boundary. Web content can try to steer the agent. Access control is Tailscale
plus a loopback bind; there is no app login. Isolation is a planned phase. See
[docs/spec.md](docs/spec.md#security-posture-honest).

## Run

Use Node 26.10.0.

```sh
npm ci
npm run dev
```

`npm run dev` serves the app and API on port 3000 with Vite middleware. Set
`STILL_PRODUCTION=1` after `npm run build` to serve `dist/` instead.

Configuration (environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Loopback port |
| `STILL_DATABASE` | `.data/still-v1.sqlite` | The single SQLite file |
| `STILL_WORKSPACE` | `workspace/` beside the database | Working directory for tools |
| `STILL_ATTACHMENTS_DIR` | `attachments/` beside the database | Attachment originals |
| `STILL_MODEL_ALLOWLIST` | all provider models | Comma-separated `provider/model` IDs the server offers and accepts |
| `OPENCODE_GO_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | Provider keys (server only, never sent to the browser) |
| `BRAVE_SEARCH_API_KEY` | unset | Enables `web_search`; without it search fails visibly |
| `STILL_VAPID_PUBLIC_KEY`, `STILL_VAPID_PRIVATE_KEY`, `STILL_VAPID_SUBJECT` | unset | Web Push |
| `STILL_FAUX_DEMO` | unset | Path to a scripted faux-provider JSON (offline demo, no paid calls) |
| `STILL_RELEASE` | `development` | Label reported by `/healthz` |

Models can cost money. Tests use the faux provider. For live testing, check
OpenCode Go's current free models and pricing, then allowlist only those.

Breaking changes start a fresh database: archive the old file and point
`STILL_DATABASE` at a new one. There is no migration framework.

## Verify

```sh
npm run check   # typecheck, Oxlint (vendored anti-slop rules), Vitest, build
```

Tests run against real disposable SQLite with the faux provider. Browser
emulation is not a real iPhone.

## Layout

| Path | Contents |
|---|---|
| `src/kernel` | Agent extension, research tools, attachments, push, feedback, extension loader |
| `src/server` | HTTP/SSE routes, chat service over the Pi Harness, model catalog |
| `src/shared` | Schemas shared by server and client |
| `src/client` | React PWA |
| `extensions/` | Optional trusted extensions, imported at start (not committed) |
| `deploy/mac` | How Still runs on the Mac mini |
| `docs` | Spec and push setup |
