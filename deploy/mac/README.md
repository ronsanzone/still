# Native Mac preparation — first implementation milestone

This directory currently provides a **read-only preflight**, not an installer.
The authoritative target is [spec v1.2](../../docs/rearchitecture-and-product-spec.md),
especially sections 13–17. The existing app still uses Arena/Builder; the kits,
generic agents, report delivery and passkey release protocol are not implemented
by this milestone. Do not expose the existing token-based Builder supervisor.

## Safe commands now

From a checkout with Node 26.10.0, substitute your actual macOS login:

```sh
node deploy/mac/preflight.mjs --owner YOUR_MAC_LOGIN --dry-run
```

This prints a plan without inspecting host configuration or credentials. On the
Mac, this next command performs read-only probes and exits 2 for missing setup:

```sh
node deploy/mac/preflight.mjs --owner YOUR_MAC_LOGIN
```

The actual `_still` home-access probe requires root and otherwise reports an
unverified check. After reviewing the script and installing the protected Node
runtime, the operator can run:

```sh
sudo /usr/local/still-host/node/bin/node deploy/mac/preflight.mjs --owner YOUR_MAC_LOGIN
```

It does not create users, install software, start daemons, change Tailscale or
read secret values. A green result is **not deployment approval**: it does not
prove ACL configuration, daemon identity/configuration, login-shell restrictions,
backup contents, reboot behavior, device notifications or passkey behavior.
The Node ownership check uses POSIX metadata; inspect macOS ACLs separately.

## Operator gates — not executed by this work

1. Approve the exclusive `_still` system account and its own primary group, no
   `staff` membership and no login shell. Choose an unused UID/GID below 500.
   Review owner-home permissions/ACLs; mode 750 or stricter alone is not proof
   that all owner files are inaccessible.
2. Install the verified official Node 26.10.0 distribution under root-owned
   `/usr/local/still-host/node`, not Homebrew. Keep its ancestors non-writable
   by `_still`; prepare the state layout from spec section 13.2. Do not use a
   root process to execute unreviewed package installation scripts.
3. Phase 0 runs **only the plain app** as `_still`, listening on localhost:3000,
   under `dev.still.app` launchd supervision. Builder stays disabled. Final
   `dev.still.host` installation waits for the hardened approval implementation.
   Deployment templates/installer and environment provisioning are still pending.
4. Configure Tailscale HTTPS/Services and owner-device-only access according to
   section 13.3; never enable Funnel. Confirm the forwarded identity-header
   behavior instead of assuming ordinary localhost traffic is authenticated.
   Preview and approval need their own origins in Phase 4.
5. Enter provider/Brave/push credentials only through the private operator setup;
   never commit them. This milestone makes no provider requests.
6. Complete the reboot, backup/restore, tailnet-origin and real-iPhone checks in
   sections 16–17. Before Phase 1, archive `phase0-final.sqlite` and deliberately
   choose fresh state. Never overwrite the dogfood database as an implicit upgrade.

## Verification and limits

`npm run check` includes preflight CLI tests and live-process identity tests.
The existing offline Builder exercise also tests Linux activation/recovery and
orphan cleanup. It is a disposable-orb test, **not a Mac provisioning command**:
it uses a test UID and must not be run on a shared host unchanged.

The platform functions support Linux `/proc` and Darwin `ps`/`pkill`; only Linux
has been executed in the development orb. Darwin process start times have
second precision, so they are not an absolute PID-reuse guarantee. The exclusive
account and cleanup remain required. App, coding shell, checks and preview share
the app account's permissions: process cleanup and separate browser origins do
not provide containment.
