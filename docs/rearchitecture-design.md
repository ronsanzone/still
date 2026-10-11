# Still: stable baseline and rearchitecture contract

Status: design handoff, not implemented. Prepared 2026-10-11 for an Opus-led rearchitecture.

**The next change is a staged product/kernel migration, not a rewrite from memory.** Preserve the reviewed working prototype, its durable identities, and its release safety properties. This document does not authorize deployment, migration, deletion of legacy data, or beginning the rearchitecture.

## 1. Authority, provenance, and how to read this document

Ron accepted the product/operational recommendations in the [parent design thread](https://ampcode.com/threads/T-01a1193b-be18-72ed-b81a-e4ee9029ce3b): “recs all make sense. we can build it and host it on the Mac mini for now and access with tailscale.” His latest sequencing instruction is to get a stable repository and full design write-up **before** Opus rearchitects it.

The following sources have different evidentiary strength:

- [Original implementation and independent verification](https://ampcode.com/threads/T-01a10784-435e-7559-a2f4-05da6f756e81): source archive, executed checks and offline recovery exercise.
- [Implementation thread](https://ampcode.com/threads/T-01a10954-0c3d-7078-b5aa-e35960fea512): authoritative complete source, including both rounds of review fixes.
- [Astra review](https://ampcode.com/threads/T-01a1269f-c6eb-742a-ae78-837dcaf9fc5e): directly inspected the verified archive; did not rerun tests or demonstrate security exploits.
- [Opus review](https://ampcode.com/threads/T-01a126bb-ea60-774d-9148-a72b7e0ece46): reconstructed source from recorded patches, with missing/failed hunks; did not run tests. Useful design analysis, not authoritative recovered source.
- [Opus Mini review](https://ampcode.com/threads/T-01a126bc-c32d-711f-8bde-fcb69257130f): relied on recorded excerpts, Astra, and upstream documentation; did not inspect the complete archive or rerun tests.

**Accepted direction** below means the consolidated recommendations accepted in the parent conversation. Detailed contracts are the resulting design synthesis, not a claim that every sentence of every review received separate approval. **Current** means implemented in the baseline. **Proposed** means future work. Unsettled details are listed explicitly in §14.

### Authoritative source

- Repository: <https://github.com/ronsanzone/still>; legacy Amp project name: `pi-mobile`.
- Published baseline: [`5755703ba40b4242d00f708894690b8483774fc0`](https://github.com/ronsanzone/still/commit/5755703ba40b4242d00f708894690b8483774fc0).
- Parent is the original empty initial commit; publication preserved its history without force-pushing.
- Archive: `still-builder-review-source.tar.gz`, 161,034 bytes, 89 source files.
- SHA-256: `6657e33d7e6e6f631de9b0761af766007a761860a6d5cc18f8b187d7bb9cab6e`.
- Recovery verified the archive hash and byte-for-byte equality of all 89 files against the published baseline. No source was reconstructed from review summaries.
- The archive excludes credentials, SQLite/runtime state, dependencies, build output, and disposable artifacts. It is evidence of source provenance, not a database backup.

The documentation commit containing this document intentionally adds to that baseline; it must not be described as having the archive's hash. The original untracked checkout was preserved. The clean versioned handoff worktree is `/home/user/workspace/still-publish`; the old `/home/user/workspace/repo` is not the authoritative handoff checkout.

## 2. Current implementation versus intended product

| Area | Current reviewed baseline | Proposed rearchitecture |
| --- | --- | --- |
| Conversation | Streaming light-theme technical chat; fixed model per conversation | One composer; per-turn model; visible kits; steer/queue; retry/edit |
| Authority | Chat/arena tools empty; explicit trusted Builder tools | Versioned host-enforced grants, stamped at admission and checked at dispatch |
| Delegation | User-triggered `/delegate` and `/arena`, 1–5 slots, custom group workflows | One generic bounded agents primitive; thin task templates |
| Results | Explicit passive selected-result return; separate explicit synthesis workload | Immutable reports; foreground tool results, passive background delivery, opt-in bounded continuation |
| Research | Not implemented | Attachments, search, fetch, citations, provenance and SSRF enforcement |
| Phone | Responsive web app and manifest; Chromium checks | Installed iPhone PWA, Web Push, real-device lifecycle testing |
| Self-editing | Builder modal, candidate coding, token approval, supervised activation | Still kit; protected supervisor-origin passkey approval; smaller deliberate kernel |
| Execution | Candidate cwd, same app UID, trusted code; not isolation | Separate execution identity and constrained target/network/data access |
| Preview | Separate configured DB/no providers, but same UID and web origin | Separate execution identity and origin; no privileged approval credentials |
| Checks | Fixed executables, candidate-controlled tests/configuration | Protected baseline suite/configuration plus candidate-added tests |
| Extensions | Trusted restart-loaded code; ordinary chats do not select it | Declared capabilities, grant-bounded selection; later live data-only skills |
| Runtime | Linux root supervisor and dedicated app UID | Linux VM on Mac Mini; Tailscale-only HTTPS; separate app/exec identities |

Source owners today: `src/server/chat.ts` owns the scoped Harness/service; `delegation.ts` owns legacy groups/tasks; `builder.ts` owns coding tools and extension loading; `src/host/{main,releases,files}.ts` owns supervision/release lifecycle; `src/shared` owns schemas; React owns presentation. The supervisor journal stores release state, not another conversation store.

Current tests validate the old contract, not the proposed architecture. They do not prove hostile-code containment, passkey security, Research safety, push delivery, real iPhone behavior, or physical provider KV-cache behavior.

## 3. Product: an owned durable assistant, not a mobile IDE

The daily-use loop is **ask → send it off → lock the phone → receive a cited report**. The self-improvement loop is **request capability → candidate → checks/diff/preview → exact-release approval → activation with rollback**.

Keep calm chronological chat, light styling, technical density, and progressive disclosure. Tools and agents should not turn the app into a dashboard. Show costs, writes, failures, pending cancellation, and uncertain effects even when activity details are collapsed.

The consolidated design includes Chats and Work surfaces: Chats for conversation; Work for tasks, reports, approvals, releases, and spend. This is a product layout recommendation, not a reason to add a second persistence authority.

### Before and after

```text
Current: chat ── separate Arena setup/results
             └─ separate Builder modal ── release supervisor

Proposed: one conversation + visible kit/target
             ├─ generic agents ── immutable reports / Work / push
             └─ Still candidate ── protected approval ── supervisor

Both: Pi Durable owns transcripts, submissions, tool tasks and recovery.
```

## 4. Kits are visible grants, not modes or prompts

- **Chat:** no tools or execution target.
- **Research:** read-only attachment/search/fetch/citation tools. “Read-only” does not mean no outbound data risk.
- **Still:** an explicitly authorized candidate target and coding tools. Release is never a model capability.
- **Workbench, v1.1:** genuinely constrained no-network scratch computation. Do not relabel a cwd as a sandbox.

At most one execution target per conversation. Kits are host-owned bundles resolved into grants, not independent admission paths. Changes occur between turns and create immutable transcript entries. Consequential authority additions require visible owner approval. Models can propose a switch; tools, extensions, web pages, attachments, and reports cannot grant authority.

Initially Research and write-capable Still authority cannot coexist in one admitted turn. Switching does not erase untrusted historical context; retain provenance and show it when granting write authority. Reassess whether to require a fresh conversation for such transitions after threat-model testing.

## 5. Protected kernel and grant enforcement

Keep a small deliberate kernel: Harness/admission wiring, capability catalog, grants, generic spawn/report/join, persistence definitions, authentication, and supervisor activation. Do not merely remove the current protected-file gate.

Proposed versioned grant records describe kit, allowed tools/effects, target/execution identity, budgets, revision, and optional expiry. The concrete schema remains to be designed. At admitted-turn creation, persist the grant revision, target, kit, model configuration, and extension/release identity together with the durable work identity.

Enforcement must be host-owned at both boundaries:

1. `configure()` selects offered tools/extensions from the admitted host grant.
2. The Harness environment factory selects **where** the tools run.
3. A protected `beforeTool` boundary checks **whether** the tool call is permitted by that admitted revision and target.

Do not assume Pi automatically freezes environment factories or hooks for the lifetime of a turn. Recovered and queued work must resolve its stamped authority, not whichever kit is currently visible in the UI. No silent grant inheritance into old chats or children.

Before implementation, specify revocation semantics for queued, running, and crash-resumed work; whether cancellation or explicit failure terminates an old grant; and compatible extension/task replacement rules. Default deny on missing or incompatible grant/target resolution. Never silently fall back to a broader environment.

Effect 4.0.0 remains the service/resource/schema boundary: `Context.Service`, `Layer.effect`, `Effect.fn`, Config, scoped resources, Stream, schema-decoded network data and tagged failures. Promises run at framework boundaries. Keep Kit Langton guidance and Dillon Mulroy lint rules without weakening them. Pin Pi Durable 1.0.2 during this migration; upgrade independently.

## 6. Generic agents replace Arena, not its durability

Provide bounded `spawn`, `message`, `wait`, `stop`, and `list` operations over ordinary durable child conversations. `/research`, `/ask`, and `/compare` are thin templates/extensions, not special backend modes. Remove bespoke Arena slots/judging/synthesis UI only after compatibility paths exist.

Contracts:

- Depth one, nonrecursive. Children receive explicitly reduced grants no stronger than the parent; Chat or Research only in v1. Never Still, write targets, or release authority.
- Maximum five concurrent children per conversation; also enforce global concurrency, spawn/run and spend budgets. Numerical values beyond five remain open.
- Fresh task brief by default. Inheritance requires an explicit inclusive frozen parent cutoff.
- Each child owns its own provider session. Retry creates a new attempt/conversation from the original cutoff, not accumulated child divergence.
- Distinct launch, attempt, report and join identities prevent duplicate local admission/delivery. Old workers cannot overwrite replacement attempts.
- Parent remains usable. Stop response and Stop agents are separate. Stopping child work includes current continuations/queued work, not merely a completed initial anchor. Define the cancellation target set and recovery race semantics explicitly.
- Durable disconnect/restart recovery must not depend on the browser remaining alive.

### Report contract and delivery

Reports are immutable snapshots carrying child/model/kit/grant identity, cutoff, attempt, status, answer hash, citations, usage/cost and timestamps. Failed/cancelled results remain identifiable; a later child continuation does not rewrite an earlier report. Report content is untrusted quoted material, not instructions to the parent.

**Foreground:** an explicit parent wait returns child results as tool results in the current run.

**Background default:** a passive durable report/card plus notification; no parent inference. Reports stay outside the parent's effective model context until explicitly consumed. “Use in chat” is a labeled passive write; “Continue with reports” explicitly admits inference. Keep delivery receipt separate from context-consumption receipt, so notification retry cannot inject a report twice.

**Opt-in continuation:** explicitly authorize a bounded parent continuation for a settled batch, with a budget and idempotent join identity. Once per batch, not once per child completion. Define partial failure/cancellation and late-result batching before implementing. Never interpret a report as permission to wake the parent or spawn more work.

No admission receipt promises exactly-once provider inference, billing, shell effects, notifications, or other external effects. Record uncertainty and make retries explicit where an effect cannot safely be replayed.

## 7. Attachments and Research are v1 capabilities

Support selected images/PDFs through camera/photos/files, extracted content, citations with inspectable source URLs and relevant passages, and model compatibility checks. Attachment storage must be private and separate from source/releases; transcript references should identify immutable attachment versions. MIME/size limits, quotas, retention/deletion and extraction lifecycle are open implementation details—not implied solved by file upload.

Search finds sources; fetch reads them. Search snippets alone are not sufficient evidence for strong claims. Track provenance and label web/attachment/report content untrusted throughout rendering and model submission.

The accepted fetch policy has two independent controls:

- **Provenance:** unconfirmed fetch only for URLs appearing verbatim in user input, attachments or search results. Model-composed URLs require owner confirmation of the full URL. Redirects must not silently bypass that policy.
- **SSRF:** block loopback, link-local, private networks, tailnet/control-plane destinations and equivalent IPv4/IPv6 forms. Revalidate resolution and redirects; avoid validating one address then connecting to a different resolution. Decide egress proxy/DNS pinning and protocol restrictions before shipping.

Provenance is not proof that an allowed URL is safe; search queries and allowed requests can still disclose information. Require tests for encoded private addresses, redirect chains, DNS rebinding, generated-URL exfiltration, and attempts to change grants from fetched text. These are proposed tests; none passed in the baseline because Research does not exist yet.

## 8. Phone behavior, push, and usage

V1 includes per-turn model selection, retry/regenerate, edit-and-resend without rewriting committed history, explicit steer versus queue during work, and cost visibility including children. Maintain chronological recovery and avoid ambiguous duplicate submissions after reconnect.

Implement iPhone installed-PWA Web Push for report-ready, approval-needed, and failures; batch low-value events. Push is a hint to fetch authoritative durable state, not the result store. Avoid sensitive content in notification payloads by default. Specify subscription revocation, delivery retry/deduplication and tap routing.

Verify real iPhone Safari and installed-PWA safe areas, keyboard/visual viewport, file/photo input, suspension, SSE reconnect, notifications and resumed navigation. Chromium narrow screenshots do not substitute for this. Background work must finish without the phone running JavaScript. iOS Web Share Target is not assumed; Shortcuts share-in is a later option. Keyboard dictation is sufficient for v1.

## 9. Practical containment, with an honest threat model

Accepted posture: one trusted owner and trusted installed extension code, with untrusted model output and external content. This is not a hardened hostile-code hosting service. Nevertheless, tools must not share the live app's authority.

Current Builder shell shares the app UID, can potentially reach its data and `/proc` environment, and has network access. Minimal inherited shell environment and candidate copying do not remove those routes. Current previews use separate configured DB/provider settings but share UID and origin. These are source-backed weaknesses, not claims of a reproduced exploit.

Proposed boundaries:

- Supervisor-owned immutable install/release/auth state.
- Separate application and execution identities; use a dedicated execution UID and/or a reviewed Linux containment mechanism such as bubblewrap.
- Only the selected candidate/target writable; approved dependencies read-only.
- No live SQLite directory, provider keys, internal admission tokens, supervisor state, or foreign process environments accessible to shell/preview execution.
- Shell network off by default. Broker narrowly scoped necessary network actions through host tools rather than handing tools provider credentials.
- Separate preview execution identity and web origin; no approval cookies/tokens or live app secrets shared with preview.
- Resource/time/process/disk limits and process-tree cleanup are required design work. The baseline's kill-all-processes-for-app-UID approach must not be reused across unrelated services.

Test denied access using an actual tool process, not assertions about configured cwd. Extension top-level imports are executable server code: merely declaring a manifest does not confine them. Do not let extension declarations create new authority classes or bypass kernel checks.

## 10. Supervisor-owned approval and hardened releases

Preserve candidate → staged snapshot → gates → immutable release → preview → exact-hash approval → activation/readiness → journal/rollback. Protected-file and dependency checks must inspect the same staged bytes used by verification; mutable source races must not bypass the gate.

Replaceable application code currently renders the token/approval UI. Move approval assets and endpoints to a protected supervisor-owned origin and installation. A changed app/preview must not capture the credential or substitute the approved digest.

Use passkey/WebAuthn approval with a fresh, expiring, single-use challenge bound server-side to candidate ID, full release digest, operation and owner session. Validate RP ID/origin and require the intended user verification. Face ID is an available authenticator UX, not a server-verifiable claim that a specific biometric was used. Typed recovery credentials remain for an explicitly designed recovery flow, not ordinary in-app activation.

The supervisor computes digest, changed paths, +/- counts, risk flags, protected-file status and affected pending tasks. Clearly distinguish model-written summaries from these facts. The release card exposes checks, diff, preview, state compatibility and rollback consequences before approval. Candidate code and models never self-approve.

### Acceptance criteria cannot be candidate-controlled

Today fixed binaries still read mutable candidate tests/configuration. Add a supervisor-owned baseline and pinned check configuration outside the candidate. Candidate tests are additional, never a replacement. At minimum verify scratch-DB boot, faux chat/streaming, reload/list/reconnect, grants and allowed/denied calls, release/extension identity and readiness. Include extensions in type/lint gates, including JS checking, and keep source fingerprints stable through checks.

Retain five releases as the accepted operating target; implement retention safely around active/previous/pending releases and pending task compatibility. Provide protected passkey-gated rollback. Journal pending before stopping the app; validate expected release identity and DB-backed readiness; commit active only after success. Recover from interrupted activation and failed readiness while leaving supervisor controls reachable.

No migrations or dependency upgrades through v1 self-edit. Do not weaken the protected kernel to enable a requested feature. Operator maintenance is a distinct operation. Code rollback does not undo schema/data changes, tool writes, provider billing or external actions. Backups and restore rehearsal are separate from retaining old code.

## 11. Compatibility is a release blocker, not cleanup

The current protected modules are intentionally not editable by Builder. This pivot requires an operator-managed release and additive compatibility layer, not a self-edit or mass rename.

Retain persisted names and compatible handlers byte-identically until safe drain:

- Documents: `still.groups`, `still.child`, `still.builder` and existing metadata/audit/provider documents.
- Entry: `still.group` and selected-result entries already in transcripts.
- Tasks: `still.child-anchor`, `still.candidate`, `still.coordinator`, `still.cancel-group` (v1).
- Extensions: `still.delegation-tasks`, `still.cancellation`, `still.builder-tools`, audit registrations and selected `still.extension.*` names.

Sequence:

1. Inventory SQLite/task/extension versions; back up and restore a production copy in an isolated environment. Never connect rehearsal Harness to live SQLite.
2. Stop new Arena/group admissions (410 for removed entry points where appropriate), but retain read/render/recovery/stop paths.
3. Keep legacy cards readable with child links. Existing normal chats get no new authority. Legacy Builder conversations map explicitly to their existing candidate target/Still grant; old children do not inherit it.
4. Add grants/reports/tasks with explicit versions. Do not invent historical report provenance by blindly backfilling old children.
5. Rehearse upgrade/reopen/drain/restart/rollback with queued, running, completed, failed and cancelling work, uncertain tool effects and pending activation.
6. Remove legacy handlers only after an agreed measured drain interval and zero relevant nonterminal tasks; keep historical documents renderable. The reviews proposed different intervals, so none is silently adopted here.

Admission-time grants and extension/release identity must remain resolvable across restart. Either maintain task/schema compatibility or drain affected work before activation. Pin Pi Durable 1.0.2 and Effect 4.0.0 throughout; dependency upgrades are separate releases. A migration that changes durable contracts is not automatically reversible by restoring old binaries.

## 12. Hosting: Linux VM on the Mac Mini, private tailnet

Ron explicitly chose the Mac Mini and Tailscale. The accepted implementation path is a small Linux VM because the supervisor is Linux/root-dependent; do not add a macOS port to this rearchitecture.

Plan a protected supervisor install, distinct app/exec users, persistent state outside releases, a service manager, Tailscale-only HTTPS, supervisor/app/preview origins, nightly SQLite backups and verified restoration, and bounded release retention. No public exposure or multi-owner account system. Determine proper WebAuthn RP/origin settings against the actual tailnet HTTPS names before enrollment.

VM product, sizing, domain/origin layout, storage/backups and enrollment recovery remain undecided. UTM/OrbStack and VPS were review examples, not selected infrastructure. Amp orbs are temporary development hosting only: product startup, tools, supervision and activation must not depend on Amp or E2B APIs, tokens or lifecycle.

## 13. Phased implementation with independently checkable gates

**Immediate scope (this handoff):** source recovery, versioned baseline, clean-install verification and design documentation only. No VM deployment or rearchitecture is performed here.

### Phase 0 — Deploy and dogfood the existing baseline

Choose VM configuration; configure private HTTPS/auth, process identities, backups and restoration. Run the reviewed app on the Mini and use it on a real iPhone before broad kernel changes. Record actual friction. The proposed week of use is a review recommendation, not a mandatory calendar gate. Do not expose the current app publicly or claim it already has the later containment/passkeys.

### Phase 1 — Compatibility and product foundation

Add legacy compatibility, grant admission/dispatch, kits, per-turn model/queue/steer/edit/retry, usage, Chats/Work and push. Preserve old task recovery. Prove grants across queued/resumed work and a locked-iPhone notification. Establish supervisor-origin approval before any newly broadened write-authority surface; do not defer that trust boundary behind cosmetic work.

### Phase 2 — Research and attachments

Implement image/PDF input, extraction, search/fetch/citations, URL provenance and SSRF policy. Prove cited phone workflows and negative network/authority cases. Do not enable Research alongside unconstrained Still execution.

### Phase 3 — Generic agents and reports

Implement bounded operations, reduced child grants, immutable reports and budgets. Exercise all delivery modes, reconnect/recovery, failure isolation, no-default-parent-inference and one local join admission per authorized batch. Replace new Arena admissions while keeping legacy recovery.

### Phase 4 — Controlled self-modification

Move Builder into Still kit; implement separate execution identity, constrained target/network access, separate preview origin, passkey-bound protected approval, protected acceptance baseline, release card/retention/rollback. Pass adversarial probes plus real end-to-end phone approval and restart/recovery tests. These safeguards are prerequisites for the new self-modification release, not claims inherited from the old offline demo.

### Phase 5 / v1.1 — Data customization and Workbench

Live versioned notes/skills/slash templates with undo, conferring no authority; later no-network scratch computation. Trusted code extensions remain versioned and restart-loaded. Do not build a marketplace or public SDK as a prerequisite.

The reviews differed on whether passkey setup belongs in foundation or phase 4. Resolve it by dependency: origin ownership and enrollment design begin in foundation; no final Still-kit release ships without passkey approval and the protected baseline. V1 comprises phases 0–4, not phase 5.

## 14. Open decisions and risks for Opus

- **Q1 — Budgets:** global concurrency, spawn count, max turns/cost, daily cap, uncertain usage and cancellation charging. Five concurrent children is settled; the rest is not.
- **Q2 — Report consumption:** concrete passive-report representation, foreground wait recovery, partial-batch continuation and late-result policy. Preserve the explicit delivery/context distinction in §6.
- **Q3 — Revocation:** queued and resumed grant behavior and compatible extension-version resolution. Never resolve missing authority permissively.
- **Q4 — Compatibility window:** reviews variously suggested one week and 30 days. Choose a measured drain interval after inspecting real task state; retain handlers until then.
- **Q5 — Hosting:** VM software/resources, tailnet HTTPS origins, RP ID, backup destination/retention and recovery access. No deployment has been performed by this handoff.
- **Q6 — Research/attachments:** provider, content limits/retention, citations/extraction, egress implementation and residual search-query leakage policy.
- **Q7 — Containment:** exact Linux execution mechanism, resource limits, secret brokering and preview identity. Verify experimentally before making stronger security claims.
- **R1 — Shared-origin/UID authority:** current baseline is trusted-owner code, not containment. Earliest evidence is a process-level denial test, not a passing unit suite.
- **R2 — Check laundering:** candidate-controlled configs/tests cannot establish protected acceptance. Run the baseline from outside replaceable source.
- **R3 — Cache claims:** logical request hashes and provider usage counters do not establish physical KV sharing/retention. Compaction changes effective prefixes and is untested in the baseline. Do not promote audit telemetry into a guarantee.
- **R4 — Mobile lifetime:** installed-PWA push and reconnect need real iPhone evidence. A working desktop/Chromium demo is insufficient.
- **R5 — Rollback:** changed data or external effects can outlive restored code. Stop and escalate incompatible persistence changes rather than presenting rollback as data recovery.

## 15. Explicit non-goals

No rearchitecture or deployment in this stabilization task. No hardened hostile-code sandbox claims, multi-user/multiplayer product, mobile IDE, native app/voice mode, arbitrary repository/remote/browser execution targets, write-capable children, general scratch shell in v1, recursive agent trees, marketplace/public SDK/policy DSL, in-flight hot replacement, migration runner/database rollback, candidate dependency changes or self-activation, bundled Pi upgrade, schedules/watchers, or silent parent inference.

Weather onboarding, iOS Shortcut sharing, decision-card extensions, broader memory/workspace features and “Ask Still why” after rollback remain suggestions, not commitments. Removing Arena/Builder product modes does not remove legacy recovery or the protected release lifecycle.

## 16. Reproducing and extending the verified baseline

Use Node 26.10.0, the checked-in lockfile and Linux for the supervisor exercise. Normal `npm run check` does not require provider keys. On this orb Oxlint's JS-plugin allocator requires `vm.overcommit_memory=1`; `.agents/resume` documents that environment prerequisite. Do not apply host sysctl changes blindly elsewhere.

```sh
git clone https://github.com/ronsanzone/still.git
cd still
# For the exact pre-design source, check out the baseline commit linked in §1.
npm ci --no-audit --no-fund
npm run check
```

The existing full check is TypeScript → Dillon Oxlint → 22 tests across three files → Vite production client build. This handoff reruns it after a clean install. The separate `tools/builder-demo.ts --exercise` workflow uses scripted faux model output but real Pi file/shell tools, processes, SQLite, staged verification, previews, activation, SIGKILL recovery and rollback. It verifies orchestration, not live model coding quality.

**Safety before exercising the existing demo:** it runs a root supervisor and uses UID/GID 65534 exclusively, kills that UID's processes, and uses port 31600. Use only a disposable Linux environment where that identity has no unrelated processes. Do not run it on the Mac Mini/shared host unchanged. Use a fresh disposable state path and no provider keys. The product supervisor also requires its own exclusive app identity; shared human/service accounts are unsafe.

```sh
# Disposable Linux environment only; see safety warning above.
sudo node --import tsx tools/builder-demo.ts --exercise /tmp/still-baseline-exercise
```

Expected: all 15 assertion groups, including exact-version activation, pending-activation recovery, supervisor/orphan cleanup, live-startup rollback, staged protected-file race rejection, type-invalid/lint-invalid extension rejection and unavailable-release recovery. Preserve evidence without credentials; do not commit demo config, runtime state or screenshots. Tests for the future contracts must be added phase by phase and must not replace these legacy/recovery checks prematurely.

### Stabilization verification result

Executed in the clean handoff worktree on Node 26.10.0/npm 10.9.9: `npm ci --no-audit --no-fund` installed 225 locked packages; `npm run check` passed typecheck, lint, all 22 tests and the production client build. The separate offline/root exercise passed all 15 assertion groups using fresh disposable state after checking the demo UID and ports were unused. No live/paid model requests, production database access, deployment, schema migration or runtime source changes were performed. These are fresh stabilization results, not merely copied historical claims.
