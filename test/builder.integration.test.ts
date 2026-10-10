import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, spawnSync } from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Stream,
  Schedule,
  Schema,
} from "effect";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { Chats, ChatFailure } from "../src/server/chat.ts";
import { ModelCatalog } from "../src/server/models.ts";
import { loadExtensions } from "../src/server/builder.ts";
import { copySource, fingerprint, sourceFiles } from "../src/host/files.ts";
import { openHost } from "../src/host/releases.ts";

const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "still-builder-test-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { recursive: true, force: true })),
);

describe("Explicit Builder authority and durable coding", () => {
  it.effect(
    "edits only the candidate with real Pi tools; ordinary chats have no tools; replay survives reopen",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const candidate = "builder-test-001";
          yield* Effect.promise(() => mkdir(join(directory, candidate)));
          yield* Effect.promise(() =>
            writeFile(join(directory, "live.txt"), "live unchanged"),
          );
          const faux = fauxProvider({ tokensPerSecond: 0 });
          const modelRuntime = createModels();
          modelRuntime.setProvider(faux.provider);

          const catalog = Layer.succeed(
            ModelCatalog,
            ModelCatalog.of({
              runtime: modelRuntime,
              choices: [{ id: "faux/faux-1", name: "Faux", provider: "faux" }],
            }),
          );

          const config = ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              STILL_DATABASE: join(directory, "chat.sqlite"),
              STILL_BUILDER_ROOT: directory,
            }),
          );

          const layer = Chats.layer.pipe(
            Layer.provide(catalog),
            Layer.provide(config),
          );

          faux.setResponses([
            (context) => {
              expect(
                context.messages.flatMap((message) =>
                  message.role === "system" ? (message.toolsAdded ?? []) : [],
                ),
              ).toHaveLength(0);

              return fauxAssistantMessage("Chat remains tool-free.");
            },
            (context) => {
              expect(
                context.messages
                  .flatMap((message) =>
                    message.role === "system" ? (message.toolsAdded ?? []) : [],
                  )
                  .map((tool) => tool.name),
              ).toEqual(["read", "write", "edit", "bash"]);

              return fauxAssistantMessage(
                fauxToolCall("write", {
                  path: "fix.txt",
                  content: "candidate change",
                }),
                { stopReason: "toolUse" },
              );
            },
            fauxAssistantMessage(
              fauxToolCall("bash", {
                command: "printf 'real shell' > shell.txt",
              }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
              "Candidate edited; owner activation still required.",
            ),
          ]);

          const input = {
            candidate,
            model: "faux/faux-1",
            text: "Fix my app in a candidate",
            requestId: candidate,
          };

          const admitted = yield* Effect.scoped(
            Effect.gen(function* () {
              const chats = yield* Chats;
              const ordinary = yield* chats.create("faux/faux-1");
              yield* chats.send(ordinary.id, {
                text: "Hello",
                requestId: "ordinary-message",
              });
              yield* chats.watch(ordinary.id).pipe(
                Stream.filter(
                  (snapshot) => !snapshot.busy && snapshot.messages.length > 1,
                ),
                Stream.runHead,
              );
              const first = yield* chats.builder(input);
              const replay = yield* chats.builder(input);
              expect(replay.id).toBe(first.id);

              const snapshot = yield* chats.watch(first.id).pipe(
                Stream.filter(
                  (snapshot) =>
                    !snapshot.busy &&
                    snapshot.messages.some((item) =>
                      item.text.includes("owner activation"),
                    ),
                ),
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              );

              expect(snapshot.builder).toBe(candidate);
              expect(snapshot.tools?.map((tool) => tool.name)).toEqual([
                "write",
                "bash",
              ]);
              expect(
                snapshot.messages.filter((item) => item.role === "user"),
              ).toHaveLength(1);

              const mismatch = yield* chats
                .builder({ ...input, text: "Changed task" })
                .pipe(Effect.flip);

              expect(mismatch).toBeInstanceOf(ChatFailure);

              if (mismatch instanceof ChatFailure)
                expect(mismatch.status).toBe(409);

              const recursive = yield* chats
                .launch(first.id, {
                  mode: "fresh",
                  sourceEntry: null,
                  task: "Delegate",
                  models: ["faux/faux-1"],
                  requestId: "no-recursion",
                })
                .pipe(Effect.flip);

              expect(recursive).toBeInstanceOf(ChatFailure);

              if (recursive instanceof ChatFailure)
                expect(recursive.status).toBe(403);

              return first;
            }).pipe(Effect.provide(layer)),
          );

          yield* Effect.gen(function* () {
            const chats = yield* Chats;
            expect(yield* chats.builder(input)).toEqual(admitted);
            expect(yield* chats.list()).toHaveLength(2);
          }).pipe(Effect.provide(layer));
          expect(
            yield* Effect.promise(() =>
              readFile(join(directory, candidate, "fix.txt"), "utf8"),
            ),
          ).toBe("candidate change");
          expect(
            yield* Effect.promise(() =>
              readFile(join(directory, candidate, "shell.txt"), "utf8"),
            ),
          ).toBe("real shell");
          expect(
            yield* Effect.promise(() =>
              readFile(join(directory, "live.txt"), "utf8"),
            ),
          ).toBe("live unchanged");
          expect(faux.state.callCount).toBe(4);
        }),
      ),
  );

  it.effect(
    "source copies exclude private files; content hashes change on divergent edits; reject symlink sources",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporary;
          const source = join(root, "source");
          const target = join(root, "target");
          yield* Effect.promise(async () => {
            await mkdir(join(source, "src"), { recursive: true });
            await mkdir(join(source, ".data"));
            await writeFile(join(source, "src/app.ts"), "original");
            await writeFile(join(source, ".env"), "private");
            await writeFile(join(source, ".data/live.sqlite"), "private");
            await copySource(source, target);
          });
          expect(yield* Effect.promise(() => sourceFiles(target))).toEqual([
            "src/app.ts",
          ]);
          const before = yield* Effect.promise(() => fingerprint(target));
          yield* Effect.promise(() =>
            writeFile(join(target, "src/app.ts"), "divergent"),
          );
          expect(yield* Effect.promise(() => fingerprint(target))).not.toBe(
            before,
          );
          yield* Effect.promise(() =>
            symlink(join(source, ".env"), join(source, "src/link.ts")),
          );
          yield* Effect.promise(async () => {
            await expect(
              copySource(source, join(root, "rejected")),
            ).rejects.toThrow("symlinks");
          });
        }),
      ),
  );

  it.effect(
    "trusted extension loads at startup and cannot replace coding tools",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          yield* Effect.promise(() =>
            writeFile(
              join(directory, "hello.mjs"),
              "export default { name: 'still.extension.hello', tools: [] };",
            ),
          );
          const registry = createRegistry();

          const extensions = yield* Effect.promise(() =>
            loadExtensions(directory, registry),
          );

          expect(extensions.map((extension) => extension.name)).toEqual([
            "still.extension.hello",
          ]);
          yield* Effect.promise(() =>
            writeFile(
              join(directory, "bad.mjs"),
              "export default { name: 'still.extension.bad', tools: [{ name: 'bash' }] };",
            ),
          );
          yield* Effect.promise(async () => {
            await expect(
              loadExtensions(directory, createRegistry()),
            ).rejects.toThrow("replace built-in");
          });
        }),
      ),
  );

  it.live(
    "extension imports cannot bypass real TypeScript and Dillon lint gates",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const extensions = join(directory, "extensions");
          const invalid = join(extensions, "invalid.ts");
          yield* Effect.promise(async () => {
            await mkdir(extensions);
            await copyFile("tsconfig.json", join(directory, "tsconfig.json"));
            await copyFile("package.json", join(directory, "package.json"));
            await symlink(
              join(process.cwd(), "node_modules"),
              join(directory, "node_modules"),
            );
            await writeFile(
              invalid,
              `import { defineExtension } from "@earendil-works/pi-durable";\n\nexport const invalid: string = 42;\n\nexport default defineExtension({ name: "still.extension.invalid" });\n`,
            );
          });
          expect(
            (yield* Effect.promise(() =>
              loadExtensions(extensions, createRegistry()),
            )).map((item) => item.name),
          ).toEqual(["still.extension.invalid"]);

          const options = {
            cwd: directory,
            env: {
              PATH: "/usr/local/bin:/usr/bin:/bin",
              HOME: directory,
              NODE_ENV: "test",
            },
            encoding: "utf8" as const,
          };

          const compiler = join(
            process.cwd(),
            "node_modules/typescript/bin/tsc",
          );

          const typeFailure = yield* Effect.sync(() =>
            spawnSync(process.execPath, [compiler, "--noEmit"], options),
          );

          expect(typeFailure.status).not.toBe(0);
          expect(typeFailure.stdout).toContain("extensions/invalid.ts");
          expect(typeFailure.stdout).toContain("TS2322");
          yield* Effect.promise(() =>
            writeFile(
              invalid,
              `import { defineExtension } from "@earendil-works/pi-durable";\n\nexport const invalid = "value"!;\n\nexport default defineExtension({ name: "still.extension.invalid" });\n`,
            ),
          );

          const typeSuccess = yield* Effect.sync(() =>
            spawnSync(process.execPath, [compiler, "--noEmit"], options),
          );

          expect(typeSuccess.status).toBe(0);

          const lintFailure = yield* Effect.sync(() =>
            spawnSync(
              process.execPath,
              [
                join(process.cwd(), "node_modules/oxlint/bin/oxlint"),
                "--threads=2",
                "extensions",
                "--config",
                join(process.cwd(), "oxlint.config.ts"),
              ],
              options,
            ),
          );

          expect(lintFailure.status).not.toBe(0);
          expect(lintFailure.stdout + lintFailure.stderr).toContain(
            "no-non-null-assertion",
          );
        }),
      ),
    { timeout: 30000 },
  );

  it.effect(
    "refuses same-user hosting rather than pretending cwd is isolation",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await expect(
            openHost({
              root: "/unused",
              source: "/unused",
              uid: process.getuid?.() ?? 0,
              gid: process.getgid?.() ?? 0,
              port: 10000,
              token: "test",
              appEnv: {},
            }),
          ).rejects.toThrow("separate");
        });
      }),
  );

  it.live(
    "SIGKILL during unsafe bash execution records interruption without replaying its side effect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporary;
          const candidate = join(directory, "crashed-builder-001");
          const database = join(directory, "chat.sqlite");
          yield* Effect.promise(() => mkdir(candidate));

          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              fork(
                "test/fixtures/builder-crash-worker.ts",
                [database, directory],
                {
                  execArgv: ["--import", "tsx"],
                  stdio: ["ignore", "ignore", "inherit", "ipc"],
                },
              ),
            ),
            (worker) =>
              Effect.promise(async () => {
                worker.kill("SIGKILL");

                const pid = Number(
                  await readFile(join(candidate, "shell.pid"), "utf8").catch(
                    () => "0",
                  ),
                );

                if (pid > 0) {
                  try {
                    process.kill(-pid, "SIGKILL");
                  } catch {
                    /* Test shell exited. */
                  }
                }
              }),
          );

          const id = yield* Effect.promise(
            () =>
              new Promise<number>((done, reject) => {
                child.once("message", (value) => {
                  try {
                    done(
                      Schema.decodeUnknownSync(
                        Schema.Struct({ id: Schema.Number }),
                      )(value).id,
                    );
                  } catch (error) {
                    reject(error);
                  }
                });
                child.once("error", reject);
              }),
          );

          yield* Effect.tryPromise(() =>
            readFile(join(candidate, "side-effects.txt"), "utf8"),
          ).pipe(
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 99 }),
          );
          yield* Effect.promise(
            () =>
              new Promise<void>((done) => {
                child.once("exit", () => done());
                child.kill("SIGKILL");
              }),
          );
          const faux = fauxProvider({ tokensPerSecond: 0 });
          faux.setResponses([
            (context) => {
              expect(
                context.messages.some(
                  (message) => message.role === "toolResult" && message.isError,
                ),
              ).toBe(true);

              return fauxAssistantMessage(
                "Interrupted tool inspected; no automatic rerun.",
              );
            },
          ]);
          const models = createModels();
          models.setProvider(faux.provider);

          const catalog = Layer.succeed(
            ModelCatalog,
            ModelCatalog.of({
              runtime: models,
              choices: [{ id: "faux/faux-1", name: "Faux", provider: "faux" }],
            }),
          );

          const config = ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              STILL_DATABASE: database,
              STILL_BUILDER_ROOT: directory,
            }),
          );

          yield* Effect.gen(function* () {
            const chats = yield* Chats;

            const snapshot = yield* chats.watch(id).pipe(
              Stream.filter(
                (value) =>
                  !value.busy &&
                  value.messages.some((message) =>
                    message.text.includes("no automatic rerun"),
                  ),
              ),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );

            expect(
              snapshot.tools?.find((tool) => tool.name === "bash")?.failed,
            ).toBe(true);
            expect(
              snapshot.messages.filter((message) => message.role === "user"),
            ).toHaveLength(1);
            expect(
              yield* Effect.promise(() =>
                readFile(join(candidate, "side-effects.txt"), "utf8"),
              ),
            ).toBe("once\n");
            expect(faux.state.callCount).toBe(1);
          }).pipe(
            Effect.provide(
              Chats.layer.pipe(Layer.provide(catalog), Layer.provide(config)),
            ),
          );
        }),
      ),
    { timeout: 15000 },
  );
});
