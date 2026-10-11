#!/usr/bin/env node
// Read-only deployment probe. Never creates users, installs files, starts daemons,
// changes Tailscale, reads secret contents, or enrolls credentials.
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.owner || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(values.owner)) {
  console.error(
    "Usage: node deploy/mac/preflight.mjs --owner <Mac-login> [--dry-run]",
  );
  process.exit(2);
}

const host = "/usr/local/still-host";
const state = "/Library/Application Support/Still";
const node = `${host}/node/bin/node`;
const home = `/Users/${values.owner}`;
const plan = {
  mode: values["dry-run"] ? "dry-run" : "read-only-probe",
  owner: values.owner,
  runtime: "Node 26.10.0, root-owned official distribution (not Homebrew)",
  host,
  state,
  origins: {
    app: "tailnet HTTPS -> 127.0.0.1:3000",
    preview: "separate :8443 origin -> 127.0.0.1:3100 (Phase 4)",
    approval: "separate still-approve hostname -> 127.0.0.1:3200 (Phase 4)",
  },
  operatorActions: [
    "Approve native provisioning; choose unused UID/GID below 500 for _still with its own group, no staff membership, no login shell",
    "Install verified Node 26.10.0 and chosen Git commit under root-owned /usr/local/still-host",
    "Create protected state/log/backup directories and provider-only application environment; never publish credentials",
    "Phase 0: run only the plain app as _still under launchd; do not expose the current token-based Builder supervisor",
    "Configure Tailscale-only HTTPS and owner-device ACL; no Funnel",
    "Verify owner-home denial, forwarded identity headers, reboot startup, backups/restore and real-iPhone dogfood",
    "Phase 1 cutover: archive phase0-final.sqlite and explicitly select a fresh database; never silently migrate or delete the old one",
  ],
  deferred: [
    "Passkey approval and caller-authority split are not implemented by this probe",
    "Containment is deferred: app, tools and preview share _still authority",
    "The probe cannot prove Tailscale ACLs, origin trust, reboot, push or Face ID behavior",
  ],
};

if (values["dry-run"]) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.log(
    JSON.stringify(
      {
        ...plan,
        blocked:
          "Native macOS is required for host probes. Use --dry-run elsewhere.",
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

const checks = [];
const record = (name, pass, detail) => checks.push({ name, pass, detail });
const command = (path, args) =>
  spawnSync(path, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    timeout: 5000,
  });

const uid = command("/usr/bin/id", ["-u", "_still"]);
record(
  "dedicated-user",
  uid.status === 0 &&
    Number(uid.stdout.trim()) > 0 &&
    Number(uid.stdout.trim()) < 500,
  "_still must exist with a non-root system UID below 500; this script never creates it",
);
const primary = command("/usr/bin/id", ["-gn", "_still"]);
const groups = command("/usr/bin/id", ["-Gn", "_still"]);
record(
  "dedicated-group",
  primary.status === 0 &&
    primary.stdout.trim() === "_still" &&
    groups.status === 0 &&
    !groups.stdout.trim().split(/\s+/).includes("staff"),
  "Primary group must be _still, with no staff membership",
);

try {
  const info = lstatSync(home);
  record(
    "owner-home-mode",
    info.isDirectory() && (info.mode & 0o027) === 0,
    "Owner home must have no other permissions or group write permission; ACL access needs the operator probe below",
  );
} catch {
  record("owner-home-mode", false, "Owner home could not be inspected");
}

if (process.getuid?.() === 0 && uid.status === 0) {
  const result = command("/usr/bin/sudo", [
    "-n",
    "-u",
    "_still",
    "/bin/ls",
    home,
  ]);
  record(
    "owner-home-list-denied",
    result.status !== null &&
      result.status !== 0 &&
      result.stderr.includes("Permission denied"),
    "A real _still process must be denied; denied listing does not prove full filesystem containment",
  );
} else {
  record(
    "owner-home-list-denied",
    false,
    "Not executed: a root-run read-only probe is needed to test actual _still access (including ACLs)",
  );
}

try {
  let path = node;
  let protectedPath = realpathSync(node) === node;

  while (path !== "/") {
    const info = lstatSync(path);
    protectedPath &&=
      !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0;
    path = dirname(path);
  }

  record(
    "protected-node-path",
    protectedPath,
    "Executable and ancestors must be root-owned, not writable by group/others, and not symlinked into Homebrew",
  );

  if (protectedPath) {
    const version = command(node, ["--version"]);
    record(
      "pinned-node",
      version.status === 0 && version.stdout.trim() === "v26.10.0",
      "Required runtime: v26.10.0",
    );
  }
} catch {
  record(
    "protected-node-path",
    false,
    "Pinned protected Node installation is missing or unreadable",
  );
}

const daemon = command("/bin/launchctl", ["print", "system/dev.still.app"]);
record(
  "phase0-launchdaemon",
  daemon.status === 0,
  "Phase 0 uses dev.still.app; final root dev.still.host belongs to the later hardened supervisor release",
);
const timeMachine = command("/usr/bin/tmutil", ["destinationinfo"]);
record(
  "backup-destination",
  timeMachine.status === 0,
  "Time Machine destination configured; complete a separate backup/restore drill",
);

console.log(JSON.stringify({ ...plan, checks }, null, 2));
process.exitCode = checks.every((check) => check.pass) ? 0 : 2;
