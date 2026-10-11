import { spawn } from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { killAllOf, processStartTime } from "../../src/host/platform.ts";

describe("supervisor process identity", () => {
  it.effect(
    "identifies a live process and no longer identifies it after exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                stdio: "ignore",
              }),
            ),
            (value) => Effect.sync(() => value.kill()),
          );

          if (!child.pid) throw new Error("Child did not start");

          const first = yield* Effect.promise(() =>
            processStartTime(child.pid ?? 0),
          );

          expect(first).not.toBeNull();
          expect(first).not.toBe("");
          expect(
            yield* Effect.promise(() => processStartTime(child.pid ?? 0)),
          ).toBe(first);
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
                child.kill();
              }),
          );
          expect(
            yield* Effect.promise(() => processStartTime(child.pid ?? 0)),
          ).toBeNull();
        }),
      ),
  );

  it.effect(
    "refuses unsafe identities before looking up or killing processes",
    () =>
      Effect.gen(function* () {
        for (const uid of [0, -1, 1.5, Number.NaN, process.getuid?.() ?? 0]) {
          const result = yield* Effect.tryPromise(() => killAllOf(uid)).pipe(
            Effect.result,
          );

          expect(result._tag).toBe("Failure");
        }

        for (const pid of [0, -1, 1.5, Number.NaN]) {
          const result = yield* Effect.tryPromise(() =>
            processStartTime(pid),
          ).pipe(Effect.result);

          expect(result._tag).toBe("Failure");
        }
      }),
  );
});
