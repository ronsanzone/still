# Still

Ron's remote agent: one full-capability agent on Pi Durable, used from an iPhone. [docs/spec.md](docs/spec.md) is the source of truth for product, architecture, security posture and roadmap; update it when a decision changes.

- Read `.agents/skills/using-effect/SKILL.md` and the relevant references before Effect changes. Effect 4.0.0 stable APIs and installed source are authoritative.
- Use Context.Service, Layer.effect, Effect.fn, Schema.Struct records, Schema.TaggedError failures, Config, scoped resources and Stream. Run promises only at framework boundaries.
- Pi Durable owns transcripts, submissions, tasks and recovery. Do not create a second conversation store; Still state lives in Pi docs and entries in the same SQLite file.
- Every conversation gets the same agent (all installed extensions). Do not reintroduce modes or kits. Tools run on the host in `STILL_WORKSPACE` with no isolation until the isolation phase; say so honestly wherever it matters. Never pass provider keys into tool environments or to the client.
- Decode network inputs and outputs with Schema. Never log secrets.
- Use Dillon Mulroy's vendored anti-slop rules without weakening them to pass checks. Use lint autofix for spacing, then Prettier; reread changed files.
- Verify with `npm run check`. Browser-check narrow and desktop layouts. Report mock providers honestly; browser emulation is not a real iPhone.
- Automated tests use the faux provider (no paid requests). For live tests, check OpenCode Go's current free models and pricing (https://opencode.ai/docs/go/) and select only a confirmed free model. As of 2026-10-11 that is `opencode-go/longcat-2.5-preview-free`; `space-bunny-free` is no longer free even though the installed catalog lists it. Never fall back to a paid model or reuse a paid-model conversation for testing without Ron's approval.
- `.data` contains private SQLite data; never commit it. The app has no login: it relies on a loopback bind plus Tailscale. Never expose it publicly.
