# Still

Original iPhone-first chat prototype; inspired by Pi Pocket, not a fork.

- Read `.agents/skills/using-effect/SKILL.md` and the relevant references before Effect changes. Effect 4.0.0 stable APIs and installed source are authoritative.
- Use Context.Service, Layer.effect, Effect.fn, Schema.Struct records, Schema.TaggedError failures, Config, scoped resources and Stream. Run promises only at framework boundaries.
- Pi Durable owns transcripts, submissions and recovery. Do not create a second conversation store. Chat has no tools or filesystem authority.
- Decode network inputs and outputs with Schema. Never log secrets or send provider credentials to the client.
- Use Dillon Mulroy's vendored anti-slop rules without weakening them to pass checks. Use lint autofix for spacing, then Prettier; reread changed files.
- Verify with `npm run check`. Browser-check narrow and desktop layouts. Report mock providers honestly; browser emulation is not a real iPhone.
- Automated tests use the faux provider (no paid requests). For live smoke/browser tests, verify Go's current free-model availability and pricing, then explicitly select its newest confirmed free model in a new conversation. The installed catalog currently lists `opencode-go/longcat-2.5-preview-free` and `opencode-go/space-bunny-free`; do not assume catalog order indicates recency. Never fall back to a paid model or reuse a paid-model conversation for testing without user approval.
- `.data` contains private SQLite data; never commit it. The development portal is single-owner and relies on Amp access control, not production authentication.
