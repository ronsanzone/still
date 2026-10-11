import { spawnSync } from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

describe("Mac deployment preflight", () => {
  it.effect(
    "plans without probing a host or claiming deployment readiness",
    () =>
      Effect.sync(() => {
        const result = spawnSync(
          process.execPath,
          ["deploy/mac/preflight.mjs", "--owner", "example", "--dry-run"],
          { encoding: "utf8", env: { PATH: "/nonexistent" } },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain('"mode": "dry-run"');
        expect(result.stdout).toContain("do not expose");
        expect(result.stdout).toContain("Containment is deferred");
        expect(result.stdout).not.toContain('"checks"');
      }),
  );

  it.effect("rejects missing or path-like owner names", () =>
    Effect.sync(() => {
      for (const args of [[], ["--owner", "../root"], ["--owner", "-root"]]) {
        const result = spawnSync(
          process.execPath,
          ["deploy/mac/preflight.mjs", ...args, "--dry-run"],
          { encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
      }
    }),
  );

  it.effect(
    "does not report successful native probes on another platform",
    () =>
      Effect.sync(() => {
        if (process.platform === "darwin") return;

        const result = spawnSync(
          process.execPath,
          ["deploy/mac/preflight.mjs", "--owner", "example"],
          { encoding: "utf8" },
        );

        expect(result.status).toBe(2);
        expect(result.stdout).toContain("Native macOS is required");
        expect(result.stdout).not.toContain('"checks"');
      }),
  );
});
