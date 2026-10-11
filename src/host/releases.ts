import { spawn, type ChildProcess } from "node:child_process";
import { timingSafeEqual, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  symlink,
  rm,
  lstat,
  chmod,
  readdir,
  open,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  Config,
  Context,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import {
  BuilderStatus,
  CandidateVersion,
  Readiness,
  VersionId,
  type VersionAction,
} from "../shared/builder.ts";
import {
  atomicJson,
  copySource,
  fingerprint,
  permissions,
  sourceDiff,
  sourceFiles,
} from "./files.ts";
import { killAllOf, processStartTime } from "./platform.ts";

export class BuilderFailure extends Schema.TaggedError<BuilderFailure>()(
  "BuilderFailure",
  {
    message: Schema.String,
    status: Schema.Number,
  },
) {}

const CandidateState = CandidateVersion.mapFields((fields) => ({
  ...fields,
  version: Schema.mutableKey(fields.version),
  status: Schema.mutableKey(fields.status),
  diff: Schema.mutableKey(fields.diff),
  checks: Schema.mutableKey(fields.checks),
  preview: Schema.mutableKey(fields.preview),
}));

const Journal = Schema.Struct({
  active: Schema.mutableKey(BuilderStatus.fields.active),
  previous: Schema.mutableKey(BuilderStatus.fields.previous),
  pending: Schema.mutableKey(BuilderStatus.fields.pending),
  outcome: Schema.mutableKey(BuilderStatus.fields.outcome),
  candidates: Schema.mutable(Schema.Array(CandidateState)),
  processes: Schema.mutableKey(
    Schema.Array(Schema.Struct({ pid: Schema.Number, started: Schema.String })),
  ),
});

export interface HostSettings {
  readonly root: string;
  readonly source: string;
  readonly uid: number;
  readonly gid: number;
  readonly port: number;
  readonly token: string;
  readonly appEnv: NodeJS.ProcessEnv;
}

const attempt = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      error instanceof BuilderFailure
        ? error
        : new BuilderFailure({
            message:
              error instanceof Error
                ? error.message
                : "Builder operation failed.",
            status: 500,
          }),
  });

const stopped = (child: ChildProcess) =>
  new Promise<void>((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveStop();

      return;
    }

    child.once("exit", () => resolveStop());
  });

// Numeric OS identities are mandatory. cwd/read-only modes alone do not constrain a trusted shell.
export async function openHost(settings: HostSettings) {
  const { root, uid, gid } = settings;
  const owner = process.getuid?.();
  const group = process.getgid?.();

  if (owner !== 0 || group === undefined || owner === uid || uid === 0)
    throw new BuilderFailure({
      message:
        "Supervisor must run as root and use a separate non-root app OS identity.",
      status: 503,
    });
  const ownerUid = owner;
  const ownerGid = group;
  await mkdir(root, { recursive: true, mode: 0o755 });

  if ((await lstat(root)).uid !== ownerUid)
    throw new Error("Host state root must be owned by supervisor");
  await chmod(root, 0o755);
  const lockPath = join(root, "supervisor.lock");

  const lockRecord = Schema.Struct({
    pid: Schema.Number,
    started: Schema.String,
  });

  const existingLock = await readFile(lockPath, "utf8").catch(() => undefined);

  if (existingLock) {
    const previousLock = Schema.decodeUnknownSync(
      Schema.fromJsonString(lockRecord),
    )(existingLock);

    const started = await processStartTime(previousLock.pid);

    if (started && started === previousLock.started)
      throw new Error("Another supervisor already owns this host state");
    await rm(lockPath);
  }

  const lockFile = await open(lockPath, "wx", 0o600);

  try {
    await lockFile.writeFile(
      JSON.stringify({
        pid: process.pid,
        started: await processStartTime(process.pid),
      }),
    );
    await lockFile.sync();
  } finally {
    await lockFile.close();
  }

  // This UID must belong exclusively to this Still host. Pi bash groups detach from the app's group.
  // OS-account cleanup also catches orphan coding shells/checks after supervisor/app SIGKILL.
  async function stopIdentity() {
    await killAllOf(uid);
  }

  await stopIdentity();

  for (const directory of [
    "releases",
    "candidates",
    "staging",
    "data",
    "previews",
  ])
    await mkdir(join(root, directory), { recursive: true, mode: 0o755 });
  await permissions(join(root, "data"), uid, gid, true);
  await permissions(join(root, "previews"), uid, gid, true);
  await chmod(join(root, "data"), 0o700);
  await chmod(join(root, "previews"), 0o700);
  const journalPath = join(root, "journal.json");
  let journal: Schema.Schema.Type<typeof Journal>;
  let app: ChildProcess | undefined;
  let preview: ChildProcess | undefined;
  const internalToken = randomUUID();
  let closed = false;
  const dependencies = join(settings.source, "node_modules");

  const candidatePath = (id: string) =>
    join(root, "candidates", Schema.decodeUnknownSync(VersionId)(id));

  const releasePath = (version: string) => join(root, "releases", version);
  const save = () => atomicJson(journalPath, journal);

  async function linkDependencies(path: string) {
    await mkdir(join(path, "node_modules"), { recursive: true });

    for (const name of await readdir(dependencies)) {
      if (name.startsWith(".") && name !== ".bin") continue;
      await symlink(
        join(dependencies, name),
        join(path, "node_modules", name),
      ).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
  }

  async function command(directory: string, args: string[]) {
    return await new Promise<string>((resolveCommand, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: directory,
        uid,
        gid,
        detached: true,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: join(root, "previews"),
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      const collect = (text: Buffer) => {
        output = (output + text.toString()).slice(-32000);
      };

      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const timer = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      }, 180000);

      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);

        if (code === 0) resolveCommand(output);
        else
          reject(
            new BuilderFailure({
              message: `Candidate checks failed (exit ${code}).\n${output}`,
              status: 422,
            }),
          );
      });
    });
  }

  async function stage(source: string, name: string, base?: string) {
    const path = join(root, "staging", name);
    await rm(path, { recursive: true, force: true });
    await copySource(source, path);
    await linkDependencies(path);
    await permissions(path, uid, gid, true);
    const before = await fingerprint(path);
    const files = await sourceFiles(path);

    // Gate the copied bytes consumed by checks, never an earlier read of the mutable candidate.
    if (base)
      for (const file of new Set([...files, ...(await sourceFiles(base))])) {
        if (/migration/i.test(file))
          throw new BuilderFailure({
            message:
              "Migrations require explicit operator handling; activation is rejected.",
            status: 422,
          });

        if (
          file.startsWith("src/host/") ||
          file.startsWith("src/kernel/") ||
          file.startsWith("deploy/") ||
          [
            "src/server/chat.ts",
            "src/server/main.ts",
            "package.json",
            "package-lock.json",
          ].includes(file)
        ) {
          if (
            (await readFile(join(path, file), "utf8").catch(() => "")) !==
            (await readFile(join(base, file), "utf8").catch(() => ""))
          )
            throw new BuilderFailure({
              message: `Protected host, dependency or persistence definition changed: ${file}. Handle this outside Builder.`,
              status: 422,
            });
        }
      }

    // Run fixed commands, not candidate-controlled package scripts. Dependency upgrades need host maintenance.
    const logs: string[] = [];

    for (const args of [
      [join(dependencies, "typescript/bin/tsc"), "--noEmit"],
      [
        join(dependencies, "oxlint/bin/oxlint"),
        "--threads=2",
        "src",
        "test",
        "tools/builder-demo.ts",
        "vite.config.ts",
        "oxlint.config.ts",
        ...files.filter((file) => file.startsWith("extensions/")),
      ],
      [join(dependencies, "vitest/vitest.mjs"), "run", "--maxWorkers=2"],
      [join(dependencies, "vite/bin/vite.js"), "build"],
    ])
      logs.push(await command(path, args));

    if (before !== (await fingerprint(path)))
      throw new BuilderFailure({
        message: "Checks modified source. Validate a stable candidate again.",
        status: 409,
      });
    const version = await fingerprint(path, true);
    const release = releasePath(version);

    if (!(await lstat(release).catch(() => undefined))) {
      await copySource(path, release, true);

      if (version !== (await fingerprint(release, true)))
        throw new Error("Release changed during snapshot");
      await linkDependencies(release);
      await permissions(release, ownerUid, ownerGid, false);
    }

    await rm(path, { recursive: true, force: true });

    return { version, checks: logs.join("\n") };
  }

  async function remember(child: ChildProcess) {
    if (!child.pid) throw new Error("App did not start");
    const started = await processStartTime(child.pid);

    if (!started) throw new Error("Cannot identify app process start time");
    journal.processes = [...journal.processes, { pid: child.pid, started }];
    await save();
  }

  async function terminate(child: ChildProcess | undefined) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([
      stopped(child),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5000)),
    ]);

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Group already exited. */
    }

    await stopped(child);
  }

  async function start(version: string, isPreview: boolean) {
    const path = releasePath(version);

    if ((await fingerprint(path, true)) !== version)
      throw new Error("Immutable release digest mismatch");
    const port = settings.port + (isPreview ? 2 : 1);

    const database = join(
      root,
      isPreview ? "previews" : "data",
      isPreview ? `${version}.sqlite` : "still.sqlite",
    );

    const appEnv: NodeJS.ProcessEnv = {};

    if (!isPreview) Object.assign(appEnv, settings.appEnv);

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/server/main.ts"],
      {
        cwd: path,
        uid,
        gid,
        detached: true,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: join(root, "previews"),
          ...appEnv,
          PORT: String(port),
          STILL_DATABASE: database,
          STILL_RELEASE: version,
          STILL_PRODUCTION: "1",
          STILL_BUILDER_ROOT: join(root, "candidates"),
          STILL_INTERNAL_TOKEN: isPreview ? "" : internalToken,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let diagnostic = "";
    child.stderr?.on("data", (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(-4000);
    });
    child.on("error", () => {});
    await remember(child);

    try {
      await Effect.runPromise(
        attempt(async () => {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error("App exited before readiness");

          const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: AbortSignal.timeout(1000),
          });

          const health = Schema.decodeUnknownSync(Readiness)(
            await response.json(),
          );

          if (!response.ok || health.release !== version)
            throw new Error("Wrong release readiness");
        }).pipe(
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 49 }),
        ),
      );

      return child;
    } catch {
      await terminate(child);
      throw new BuilderFailure({
        message: `Release failed readiness. ${diagnostic}`,
        status: 422,
      });
    }
  }

  const existing = await readFile(journalPath, "utf8").catch(() => undefined);

  if (existing) {
    journal = Schema.decodeUnknownSync(Schema.fromJsonString(Journal))(
      existing,
    );

    // Clean up orphan groups only after matching the recorded process start time.
    for (const record of journal.processes) {
      const started = await processStartTime(record.pid);

      if (started && started === record.started) {
        try {
          process.kill(-record.pid, "SIGKILL");
        } catch {
          /* Exited during recovery. */
        }
      }
    }

    journal.processes = [];

    if (journal.pending) {
      journal.outcome = `Interrupted activation ${journal.pending}; restored last committed release ${journal.active}.`;
      journal.pending = null;
    }
  } else {
    const initial = await stage(settings.source, "bootstrap");
    journal = {
      active: initial.version,
      previous: null,
      pending: null,
      outcome: "Initial checked release",
      candidates: [],
      processes: [],
    };
  }

  await save();

  for (const candidate of journal.candidates) candidate.preview = null;

  try {
    app = await start(journal.active, false);
  } catch (error) {
    journal.outcome = `Startup recovery: ${error instanceof Error ? error.message : "release failed"}`;

    if (journal.previous) {
      try {
        app = await start(journal.previous, false);
        journal.active = journal.previous;
        journal.previous = null;
      } catch {
        app = undefined;
        journal.outcome =
          "No stored release passed startup readiness. Supervisor remains available; inspect live data and restore a known-good release.";
      }
    }
  }

  await save();

  async function create(id: string) {
    const path = candidatePath(id);
    const existingCandidate = journal.candidates.find((item) => item.id === id);

    if (existingCandidate) return existingCandidate;
    await copySource(releasePath(journal.active), path);
    await linkDependencies(path);
    await permissions(path, uid, gid, true);

    const candidate = Schema.decodeUnknownSync(CandidateState)({
      id,
      base: journal.active,
      version: "",
      status: "editing",
      diff: "",
      checks: "",
      preview: null,
    });

    journal.candidates.push(candidate);
    await save();

    return candidate;
  }

  async function validate(id: string) {
    const candidate = journal.candidates.find((item) => item.id === id);

    if (!candidate)
      throw new BuilderFailure({
        message: "Candidate not found.",
        status: 404,
      });
    const path = candidatePath(id);
    const base = releasePath(candidate.base);

    candidate.status = "editing";
    candidate.version = "";
    await save();

    try {
      const validated = await stage(path, id, base);
      candidate.version = validated.version;
      candidate.checks = validated.checks;
      candidate.diff = await sourceDiff(base, releasePath(validated.version));
      candidate.status = "validated";
      await terminate(preview);

      for (const other of journal.candidates) other.preview = null;
      preview = await start(candidate.version, true);
      candidate.preview = `/builder-preview/${candidate.version}/`;
      await save();

      return candidate;
    } catch (error) {
      candidate.status = "failed";
      candidate.checks =
        error instanceof Error ? error.message : "Validation failed";
      await save();
      throw error;
    }
  }

  async function activate(input: VersionAction) {
    const candidate = journal.candidates.find(
      (item) => item.id === input.candidate,
    );

    if (
      !candidate ||
      !["validated", "activated"].includes(candidate.status) ||
      candidate.version !== input.version
    )
      throw new BuilderFailure({
        message: "Approval must name the exact validated candidate version.",
        status: 409,
      });

    if (journal.active === input.version) return journal;

    if (candidate.base !== journal.active)
      throw new BuilderFailure({
        message:
          "Candidate is based on an older active release. Create a new Builder candidate.",
        status: 409,
      });
    // Approval refers to the immutable checked snapshot, never the still-editable candidate directory.
    journal.pending = input.version;
    journal.outcome = `Activating explicitly approved version ${input.version}`;
    await save();
    await terminate(preview);
    preview = undefined;

    for (const other of journal.candidates) other.preview = null;
    await terminate(app);
    await stopIdentity();

    try {
      app = await start(input.version, false);
      journal.previous = journal.active;
      journal.active = input.version;
      candidate.status = "activated";
      journal.outcome =
        "Approved release passed readiness; prior release retained.";
    } catch (error) {
      candidate.status = "failed";
      candidate.checks += `\n\nActivation failed: ${error instanceof Error ? error.message : "readiness failed"}`;

      try {
        app = await start(journal.active, false);
        journal.outcome = `Activation rolled back to ${journal.active}; failed-version diagnostics are in its check details.`;
      } catch (rollbackError) {
        app = undefined;
        journal.outcome =
          "Activation and previous-release readiness failed. Supervisor remains available; live data needs owner inspection.";
        candidate.checks += `\n\nRollback failed: ${rollbackError instanceof Error ? rollbackError.message : "readiness failed"}`;
      }
    }

    journal.pending = null;
    await save();

    return journal;
  }

  async function monitor() {
    if (closed || journal.pending) return;

    if (app && app.exitCode === null && app.signalCode === null) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${settings.port + 1}/healthz`,
          { signal: AbortSignal.timeout(1500) },
        );

        const health = Schema.decodeUnknownSync(Readiness)(
          await response.json(),
        );

        if (response.ok && health.release === journal.active) return;
      } catch {
        /* Readiness failure triggers controlled restart. */
      }

      await terminate(app);
    }

    const broken = journal.active;
    await terminate(preview);
    preview = undefined;

    for (const candidate of journal.candidates) candidate.preview = null;
    await stopIdentity();

    try {
      app = await start(journal.active, false);
      journal.outcome = "Active release restarted after exit.";
    } catch {
      if (!journal.previous)
        throw new Error(
          "No healthy release available; supervisor remains reachable",
        );
      app = await start(journal.previous, false);
      journal.active = journal.previous;
      journal.previous = broken;
      journal.outcome =
        "Exited release failed restart; restored previous release.";
    }

    await save();
  }

  async function close() {
    closed = true;
    await terminate(preview);
    await terminate(app);
    await stopIdentity();
    await rm(lockPath, { force: true });
  }

  return {
    status: () => Schema.decodeUnknownSync(BuilderStatus)(journal),
    create,
    validate,
    activate,
    monitor,
    close,
    appPort: settings.port + 1,
    previewPort: settings.port + 2,
    internalToken,
    authorize: (token: string) => {
      const a = Buffer.from(token);
      const b = Buffer.from(settings.token);

      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}

export class Releases extends Context.Service<
  Releases,
  {
    readonly host: Awaited<ReturnType<typeof openHost>>;
    readonly create: (
      id: string,
    ) => Effect.Effect<CandidateVersion, BuilderFailure>;
    readonly validate: (
      id: string,
    ) => Effect.Effect<CandidateVersion, BuilderFailure>;
    readonly activate: (
      input: VersionAction,
    ) => Effect.Effect<BuilderStatus, BuilderFailure>;
  }
>()("still/Releases") {
  static readonly layer = Layer.effect(
    Releases,
    Effect.gen(function* () {
      const settings: HostSettings = {
        root: resolve(yield* Config.String("STILL_HOST_ROOT")),
        source: resolve(yield* Config.String("STILL_HOST_SOURCE")),
        uid: yield* Config.Int("STILL_APP_UID"),
        gid: yield* Config.Int("STILL_APP_GID"),
        port: yield* Config.Int("PORT").pipe(Config.withDefault(3000)),
        token: Redacted.value(yield* Config.Redacted("STILL_OWNER_TOKEN")),
        appEnv: {},
      };

      if (settings.token.length < 32)
        return yield* new BuilderFailure({
          message: "Owner token must contain at least 32 characters.",
          status: 503,
        });

      for (const key of [
        "OPENCODE_GO_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "BRAVE_SEARCH_API_KEY",
        "STILL_VAPID_PUBLIC_KEY",
        "STILL_VAPID_PRIVATE_KEY",
        "STILL_VAPID_SUBJECT",
        "STILL_FAUX_DEMO",
      ]) {
        const value = yield* Config.String(key).pipe(Config.withDefault(""));

        if (value) settings.appEnv[key] = value;
      }

      const host = yield* Effect.acquireRelease(
        attempt(() => openHost(settings)),
        (value) => Effect.promise(() => value.close()),
      );

      const lock = yield* Semaphore.make(1);
      yield* attempt(() => host.monitor()).pipe(
        lock.withPermit,
        Effect.catch(() => Effect.void),
        Effect.repeat(Schedule.spaced("2 seconds")),
        Effect.forkScoped,
      );

      return Releases.of({
        host,
        create: Effect.fn("Builder.create")((id) =>
          attempt(() => host.create(id)).pipe(lock.withPermit),
        ),
        validate: Effect.fn("Builder.validate")((id) =>
          attempt(() => host.validate(id)).pipe(lock.withPermit),
        ),
        activate: Effect.fn("Builder.activate")((input) =>
          attempt(() => host.activate(input)).pipe(lock.withPermit),
        ),
      });
    }),
  );
}
