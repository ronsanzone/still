import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(process.argv[3] ?? "/tmp/still-builder-demo");

const originalCopy = fs.copyFile;

const sourcePath = join(root, "candidates/demo-race-003/src/server/chat.ts");

const stagedPath = join(root, "staging/demo-race-003/src/server/chat.ts");

// Test-process-only interception: change the candidate after its initial read, exactly before copying.
// The supervisor has no test hooks; the real filesystem copy and staged policy gate still execute.
fs.copyFile = async (source, target, mode) => {
  if (source === sourcePath && target === stagedPath) {
    await fs.appendFile(
      source,
      "\n// Injected protected change during staging.\n",
    );
    await fs.writeFile(join(root, "race-injected.txt"), "injected");
  }

  await originalCopy(source, target, mode);
};

syncBuiltinESMExports();

await import("../../tools/builder-demo.ts");
