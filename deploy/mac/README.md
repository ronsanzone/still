# Running Still on the Mac mini

## Today

One Node process bound to `127.0.0.1:3000`, exposed only on the tailnet:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

Start it from a checkout after `npm ci && npm run build`, with secrets passed in
the environment by a private start script (never committed). The dogfood
script also sets a production flag, a release label, the database, the workspace,
a free-model allowlist and the provider and search keys:

```sh
env -i HOME="$HOME" PATH="<node 26.10.0 bin>:/usr/bin:/bin" \
  PORT=3000 STILL_PRODUCTION=1 STILL_RELEASE="dogfood-$(git rev-parse --short HEAD)" \
  STILL_DATABASE="$PWD/.data/still-v1.sqlite" \
  STILL_WORKSPACE="<workspace dir>" \
  STILL_MODEL_ALLOWLIST="opencode-go/longcat-2.5-preview-free" \
  OPENCODE_GO_API_KEY="…" BRAVE_SEARCH_API_KEY="…" \
  node --import tsx src/server/main.ts
```

Keep keys out of shell history. For example, read them from the macOS Keychain
(`security find-generic-password -s <item> -w`) inside the script.

Check health with `curl https://<host>.<tailnet>.ts.net/healthz`.

## Next

1. A launchd service so Still survives reboots and crashes. Until isolation
   exists, a dedicated macOS account for Still limits what the agent can reach
   on the Mac to that account's files.
2. Scheduled SQLite backups using the online backup API (not a file copy) with
   a restore drill.
3. Isolation: run each workspace in its own lightweight VM and route tools
   through Pi's `ExecutionEnv`. See [docs/spec.md](../../docs/spec.md#roadmap).

Never enable Tailscale Funnel: the app has no login of its own.
