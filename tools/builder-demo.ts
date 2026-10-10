import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schedule, Schema } from "effect";
import { createRegistry } from "@earendil-works/pi-durable";
import { Bootstrap, ChatSnapshot, Receipt } from "../src/shared/contracts.ts";
import {
  BuilderStatus,
  CandidateVersion,
  Readiness,
} from "../src/shared/builder.ts";
import { fingerprint, sourceFiles } from "../src/host/files.ts";
import { Audit } from "../src/server/audit.ts";
import { loadExtensions } from "../src/server/builder.ts";

// Real Linux process/filesystem workflow, with scripted faux model output and no provider credentials.
const Settings = Schema.Struct({
  root: Schema.String,
  source: Schema.String,
  token: Schema.String,
  port: Schema.Number,
});
const root = resolve(process.argv[3] ?? "/tmp/still-builder-demo");
const mode = process.argv[2] ?? "--exercise";
const configPath = join(root, "demo-config.json");

async function prepare() {
  if (process.getuid?.() !== 0)
    throw new Error(
      "Run this disposable Linux demo as root; app runs as nobody (65534).",
    );
  await mkdir(root, { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  const settings = {
    root,
    source: process.cwd(),
    token: randomUUID() + randomUUID(),
    port: 31600,
  };
  await writeFile(configPath, JSON.stringify(settings), { mode: 0o600 });
  const app = await readFile("src/client/app.tsx", "utf8");
  const extension = `import { defineExtension, section } from "@earendil-works/pi-durable";\n\nexport default defineExtension({\n  name: "still.extension.release-note",\n  sections: [section("release-note", () => "Owner-created release-note extension is loaded. Keep coding changes in the candidate.")],\n});\n`;
  await writeFile(
    join(root, "faux.json"),
    JSON.stringify([
      {
        text: "",
        tool: "write",
        arguments: {
          path: "src/client/app.tsx",
          content: app.replace(
            "What are you working on?",
            "What shall we improve?",
          ),
        },
      },
      {
        text: "",
        tool: "write",
        arguments: { path: "extensions/release-note.ts", content: extension },
      },
      {
        text: "",
        tool: "bash",
        arguments: {
          command:
            "printf 'candidate-shell-ran\\n' > public/builder-evidence.txt",
        },
      },
      {
        text: "Scripted faux demo: changed the welcome heading, created the release-note extension, and executed candidate shell. Owner must inspect checks/preview and approve the exact version. No live model call occurred.",
      },
    ]),
  );
  return settings;
}

async function serve() {
  const settings = Schema.decodeUnknownSync(Schema.fromJsonString(Settings))(
    await readFile(configPath, "utf8"),
  );
  Object.assign(process.env, {
    STILL_HOST_ROOT: root,
    STILL_HOST_SOURCE: settings.source,
    STILL_APP_UID: "65534",
    STILL_APP_GID: "65534",
    PORT: String(settings.port),
    STILL_OWNER_TOKEN: settings.token,
    STILL_FAUX_DEMO: join(root, "faux.json"),
  });
  // Boundary-only environment setup. The actual product supervisor uses Config and no Amp APIs.
  await import("../src/host/main.ts");
}

async function exercise() {
  const settings = await prepare();
  const url = `http://127.0.0.1:${settings.port}`;
  let supervisor: ChildProcess | undefined;
  const evidence: string[] = [];
  const record = (text: string) => {
    evidence.push(text);
    console.log(text);
  };
  async function request<A>(
    path: string,
    schema: Schema.Codec<A>,
    body?:
      | { candidate: string; version?: string }
      | { text: string; model: string; requestId: string },
    owner = true,
  ) {
    const response = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        "x-still-owner": owner ? settings.token : "",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
    return Schema.decodeUnknownSync(schema)(data);
  }
  async function start(race = false) {
    supervisor = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        race ? "test/fixtures/builder-stage-race.ts" : "tools/builder-demo.ts",
        "--serve",
        root,
      ],
      {
        cwd: settings.source,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    supervisor.stderr?.on("data", (data) => process.stderr.write(data));
    await Effect.runPromise(
      Effect.tryPromise(() =>
        request("/api/builder/status", BuilderStatus),
      ).pipe(
        Effect.retry({ schedule: Schedule.spaced("300 millis"), times: 199 }),
      ),
    );
  }
  async function stop(signal: "SIGTERM" | "SIGKILL") {
    const child = supervisor;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      supervisor = undefined;
      return;
    }
    const exited = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    child.kill(signal);
    await exited;
    supervisor = undefined;
  }
  async function snapshot(id: number) {
    const response = await fetch(`${url}/api/chats/${id}/events`, {
      headers: { "x-still-owner": settings.token },
      signal: AbortSignal.timeout(20000),
    });
    assert(response.ok);
    assert(response.body);
    let text = "";
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString();
      const lines = text.split("\n\n");
      text = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const value = Schema.decodeUnknownSync(
            Schema.fromJsonString(ChatSnapshot),
          )(line.slice(6));
          if (
            !value.busy &&
            value.messages.some((message) =>
              message.text.includes("No live model call"),
            )
          )
            return value;
        }
      }
    }
    throw new Error("No completed Builder snapshot");
  }
  try {
    await start();
    const initial = await request("/healthz", Readiness);
    assert.equal((await stat(join(root, "data"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "previews"))).mode & 0o777, 0o700);
    const duplicate = spawn(
      process.execPath,
      ["--import", "tsx", "tools/builder-demo.ts", "--serve", root],
      {
        cwd: settings.source,
        stdio: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    const duplicateCode = await new Promise<number | null>((done) =>
      duplicate.once("exit", done),
    );
    assert.notEqual(duplicateCode, 0);
    assert.equal(
      (await request("/healthz", Readiness)).release,
      initial.release,
    );
    record("PASS second supervisor refused before it can stop the active app");
    const unauthorized = await fetch(`${url}/api/builder/status`);
    assert.equal(unauthorized.status, 401);
    record("PASS ownerless Builder status rejected (401)");
    const task = {
      text: "Change the welcome heading and create an extension in a candidate. Do not activate.",
      model: "faux/faux-1",
      requestId: "demo-builder-001",
    };
    const receipt = await request("/api/builder/create", Receipt, task);
    const replay = await request("/api/builder/create", Receipt, task);
    assert.deepEqual(receipt, replay);
    const completed = await snapshot(receipt.id);
    assert.equal(
      completed.messages.filter((message) => message.role === "user").length,
      1,
    );
    assert.deepEqual(
      completed.tools?.map((tool) => tool.name),
      ["write", "write", "bash"],
    );
    assert(completed.tools?.every((tool) => !tool.failed));
    const audit = await request(`/api/chats/${receipt.id}/audit`, Audit);
    assert.equal(audit.requests.length, 4);
    assert(audit.requests.every((item) => item.model === "faux/faux-1"));
    assert(
      audit.requests.every(
        (item) => item.sessionHash === audit.requests[0]?.sessionHash,
      ),
    );
    const candidate = join(root, "candidates", task.requestId);
    assert.equal(
      await readFile(join(candidate, "public/builder-evidence.txt"), "utf8"),
      "candidate-shell-ran\n",
    );
    assert(
      (await readFile(join(candidate, "src/client/app.tsx"), "utf8")).includes(
        "What shall we improve?",
      ),
    );
    assert.equal(
      await fingerprint(join(root, "releases", initial.release), true),
      initial.release,
    );
    const copied = await sourceFiles(candidate);
    assert(!copied.some((file) => /\.data|\.env|sqlite/.test(file)));
    record(
      "PASS real Pi write/write/bash tasks; one prompt after replay; active release unchanged; candidate excludes DB/credentials",
    );
    const permission = await new Promise<number | null>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(join(root, "releases", initial.release, "index.html"))}, 'bad')`,
        ],
        { uid: 65534, gid: 65534, stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", done);
    });
    assert.notEqual(permission, 0);
    assert.equal(
      await fingerprint(join(root, "releases", initial.release), true),
      initial.release,
    );
    record("PASS app OS identity cannot write immutable live source");
    const validated = await request("/api/builder/validate", CandidateVersion, {
      candidate: task.requestId,
    });
    assert.equal(validated.status, "validated");
    assert(validated.diff.includes("What shall we improve?"));
    assert(validated.preview);
    const previewHealth = await request(
      `${validated.preview}healthz`,
      Readiness,
    );
    assert.equal(previewHealth.release, validated.version);
    assert(previewHealth.extensions.includes("still.extension.release-note"));
    assert.equal(
      (await request(`${validated.preview}api/bootstrap`, Bootstrap)).chats
        .length,
      0,
    );
    assert.equal(
      (await request(`${validated.preview}api/bootstrap`, Bootstrap)).models
        .length,
      0,
    );
    record(
      "PASS fixed type/lint/test/build checks; exact-version preview uses empty separate DB and no providers; new extension loaded",
    );
    const wrong = await fetch(`${url}/api/builder/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-still-owner": settings.token,
      },
      body: JSON.stringify({
        candidate: task.requestId,
        version: "0".repeat(64),
      }),
    });
    assert.equal(wrong.status, 409);
    const sessionResponse = await fetch(`${url}/api/builder/status`, {
      headers: { "x-still-owner": settings.token },
    });
    const cookie =
      sessionResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
    const cookieOnly = await fetch(`${url}/api/builder/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        candidate: task.requestId,
        version: validated.version,
      }),
    });
    assert.equal(cookieOnly.status, 401);
    record(
      "PASS wrong hash rejected (409); preview/session cookie alone cannot activate (401)",
    );
    // Later edits cannot change the owner's approved immutable snapshot.
    await writeFile(
      join(candidate, "public/later-edit.txt"),
      "Not part of approved version",
    );
    const activated = await request("/api/builder/activate", BuilderStatus, {
      candidate: task.requestId,
      version: validated.version,
    });
    assert.equal(activated.active, validated.version);
    const activeHealth = await request("/healthz", Readiness);
    assert.equal(activeHealth.release, validated.version);
    assert(activeHealth.extensions.includes("still.extension.release-note"));
    assert.equal((await fetch(url + "/later-edit.txt")).status, 404);
    assert.equal(
      (await snapshot(receipt.id)).messages.filter(
        (message) => message.role === "user",
      ).length,
      1,
    );
    record(
      "PASS explicit approved hash activated; later candidate edits excluded; release identity/extension/transcript persisted",
    );
    const orphan = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { uid: 65534, gid: 65534, detached: true, stdio: "ignore" },
    );
    const orphanExit = new Promise<void>((done) =>
      orphan.once("exit", () => done()),
    );
    await new Promise<void>((done) => orphan.once("spawn", () => done()));
    await stop("SIGKILL");
    await start();
    await orphanExit;
    assert.equal(orphan.signalCode, "SIGKILL");
    assert.equal(
      (await request("/healthz", Readiness)).release,
      validated.version,
    );
    assert.equal((await snapshot(receipt.id)).tools?.length, 3);
    record(
      "PASS SIGKILL supervisor recovery cleans orphan app/detached account process, reopens same DB, keeps durable coding transcript",
    );
    const brokenTask = { ...task, requestId: "demo-broken-002" };
    // Allocate a candidate without triggering a second scripted model run: journal is filesystem lifecycle, not a transcript store.
    const { openHost } = await import("../src/host/releases.ts");
    await stop("SIGTERM");
    const direct = await openHost({
      root,
      source: settings.source,
      uid: 65534,
      gid: 65534,
      port: settings.port,
      token: settings.token,
      appEnv: { STILL_FAUX_DEMO: join(root, "faux.json") },
    });
    await direct.create(brokenTask.requestId);
    await direct.create("demo-race-003");
    await direct.create("demo-extension-004");
    await direct.close();
    const broken = join(root, "candidates", brokenTask.requestId);
    const main = await readFile(join(broken, "src/server/main.ts"), "utf8");
    await writeFile(
      join(broken, "src/server/main.ts"),
      `${main}\nconst liveDatabase = await runtime.runPromise(Config.String("STILL_DATABASE"));\n\nif (!liveDatabase.includes("/previews/"))\n  throw new Error("Injected live startup failure");\n`,
    );
    await start();
    const checkedBroken = await request(
      "/api/builder/validate",
      CandidateVersion,
      { candidate: brokenTask.requestId },
    );
    const inFlight = request("/api/builder/activate", BuilderStatus, {
      candidate: brokenTask.requestId,
      version: checkedBroken.version,
    }).catch(() => undefined);
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        const journal = JSON.parse(
          await readFile(join(root, "journal.json"), "utf8"),
        );
        if (journal.pending !== checkedBroken.version)
          throw new Error("Wait for durable pending activation");
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 99 }),
      ),
    );
    await stop("SIGKILL");
    await inFlight;
    await start();
    const recovered = await request("/api/builder/status", BuilderStatus);
    assert.equal(recovered.active, validated.version);
    assert.equal(recovered.pending, null);
    assert(recovered.outcome.includes("Interrupted activation"));
    record(
      "PASS crash at durable pending activation restores last committed healthy version (not partially activated code)",
    );
    const rolledBack = await request("/api/builder/activate", BuilderStatus, {
      candidate: brokenTask.requestId,
      version: checkedBroken.version,
    });
    assert.equal(rolledBack.active, validated.version);
    assert(rolledBack.outcome.includes("rolled back"));
    const failedCandidate = rolledBack.candidates.find(
      (item) => item.id === brokenTask.requestId,
    );
    assert.equal(failedCandidate?.status, "failed");
    assert(failedCandidate?.checks.includes("Injected live startup failure"));
    assert.equal(
      (await request("/healthz", Readiness)).release,
      validated.version,
    );
    assert.equal((await snapshot(receipt.id)).tools?.length, 3);
    record(
      "PASS live-only startup failure rolls back; supervisor stays reachable; prior DB/transcript remains (no migration applied)",
    );
    await writeFile(
      join(broken, "src/server/chat.ts"),
      "// unsupported persistence change",
    );
    const migration = await fetch(`${url}/api/builder/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-still-owner": settings.token,
      },
      body: JSON.stringify({ candidate: brokenTask.requestId }),
    });
    assert.equal(migration.status, 422);
    record(
      "PASS persistence-definition change rejected (422); code rollback is not a DB rollback",
    );
    await stop("SIGTERM");
    await start(true);
    const raceSource = join(
      root,
      "candidates/demo-race-003/src/server/chat.ts",
    );
    assert.equal(
      await readFile(raceSource, "utf8"),
      await readFile(
        join(root, "releases", validated.version, "src/server/chat.ts"),
        "utf8",
      ),
    );
    await assert.rejects(
      () =>
        request("/api/builder/validate", CandidateVersion, {
          candidate: "demo-race-003",
        }),
      /HTTP 422:.*Protected.*src\/server\/chat\.ts/,
    );
    assert.equal(
      await readFile(join(root, "race-injected.txt"), "utf8"),
      "injected",
    );
    assert(
      (
        await readFile(
          join(root, "staging/demo-race-003/src/server/chat.ts"),
          "utf8",
        )
      ).includes("Injected protected change"),
    );
    const raceStatus = await request("/api/builder/status", BuilderStatus);
    assert.equal(raceStatus.active, validated.version);
    assert.equal(
      raceStatus.candidates.find((item) => item.id === "demo-race-003")
        ?.version,
      "",
    );
    record(
      "PASS protected edit injected after candidate read/before copy is rejected on staged bytes (422), with no admitted version",
    );

    const extensionDirectory = join(
      root,
      "candidates/demo-extension-004/extensions",
    );
    const invalidExtension = join(extensionDirectory, "invalid.ts");
    await writeFile(
      invalidExtension,
      `import { defineExtension } from "@earendil-works/pi-durable";\n\nexport const invalid: string = 42;\n\nexport default defineExtension({ name: "still.extension.invalid" });\n`,
    );
    assert(
      (await loadExtensions(extensionDirectory, createRegistry())).some(
        (item) => item.name === "still.extension.invalid",
      ),
    );
    await assert.rejects(
      () =>
        request("/api/builder/validate", CandidateVersion, {
          candidate: "demo-extension-004",
        }),
      /HTTP 422:.*extensions\/invalid\.ts.*TS2322/,
    );
    record(
      "PASS importable type-invalid extension rejected by staged TypeScript gate (TS2322/422)",
    );
    await writeFile(
      invalidExtension,
      `import { defineExtension } from "@earendil-works/pi-durable";\n\nexport const invalid = "value"!;\n\nexport default defineExtension({ name: "still.extension.invalid" });\n`,
    );
    await assert.rejects(
      () =>
        request("/api/builder/validate", CandidateVersion, {
          candidate: "demo-extension-004",
        }),
      /HTTP 422:.*no-non-null-assertion/,
    );
    assert.equal(
      (await request("/api/builder/status", BuilderStatus)).active,
      validated.version,
    );
    record(
      "PASS type-valid extension rejected by fixed Dillon/Oxlint extension gate (422)",
    );
    await stop("SIGTERM");
    const unavailableRoot = join(root, "unavailable");
    await mkdir(unavailableRoot);
    await writeFile(
      join(unavailableRoot, "journal.json"),
      JSON.stringify({
        active: "0".repeat(64),
        previous: "1".repeat(64),
        pending: null,
        outcome: "Injected missing releases",
        candidates: [],
        processes: [],
      }),
      { mode: 0o600 },
    );
    const unavailableHost = await openHost({
      ...settings,
      root: unavailableRoot,
      uid: 65534,
      gid: 65534,
      appEnv: {},
    });
    try {
      assert.equal(unavailableHost.status().active, "0".repeat(64));
      assert(
        unavailableHost
          .status()
          .outcome.includes("Supervisor remains available"),
      );
    } finally {
      await unavailableHost.close();
    }
    record(
      "PASS missing active and previous releases preserve supervisor service/status rather than failing its startup",
    );
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          initialRelease: initial.release,
          activeRelease: validated.version,
          failedRelease: checkedBroken.version,
          conversationId: receipt.id,
          requestAudit: audit,
          usageEvidence:
            "Faux simulation only. Logical hook hashes and synthetic usage do not establish wire payloads or provider-side KV/cache behavior.",
          evidence,
        },
        null,
        2,
      ),
    );
    record(
      `PASS Builder end-to-end offline workflow; evidence saved at ${join(root, "evidence.json")}`,
    );
  } finally {
    await stop("SIGTERM");
  }
}

if (mode === "--prepare") {
  await prepare();
  console.log(
    `Prepared offline demo at ${root}; owner token stays in mode-0600 demo-config.json.`,
  );
} else if (mode === "--serve") await serve();
else await exercise();
