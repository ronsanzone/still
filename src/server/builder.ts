import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  defineDoc,
  defineExtension,
  type Extension,
  type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from "@earendil-works/pi-durable/tools";
import { Schema } from "effect";

export const BuilderDoc = defineDoc({
  kind: "still.builder",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ candidate: "", task: "", model: "" }),
});

export const BuilderTools = defineExtension({
  name: "still.builder-tools",
  tools: [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool({
      prepare: (execution) => {
        execution.inheritEnv = false;
        execution.env = { PATH: "/usr/local/bin:/usr/bin:/bin" };
      },
    }),
  ],
});

const ExtensionExport = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^still\.extension\.[\w-]+$/)),
});

// Trusted executable modules, installed at process startup only. No hot replacement during durable tool invocations.
export async function loadExtensions(directory: string, registry: Registry) {
  const names = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  const loaded: Extension[] = [];

  for (const file of names.sort()) {
    if (!/^[\w-]+\.(ts|js|mjs)$/.test(file))
      throw new Error(`Unsupported extension file: ${file}`);
    const module = await import(pathToFileURL(join(directory, file)).href);
    const manifest = Schema.decodeUnknownSync(ExtensionExport)(module.default);

    if (registry.snapshot().extension(manifest.name))
      throw new Error(`Duplicate extension: ${manifest.name}`);
    // SAFETY: trusted owner-authored modules implement Pi's Extension contract. Runtime registry validates collisions;
    // imported JavaScript executes with host authority, and is not made safe by schema validation.
    const extension = module.default as Extension;

    if (
      extension.tools?.some((tool) =>
        ["read", "write", "edit", "bash"].includes(tool.name),
      )
    )
      throw new Error("Extensions cannot replace built-in coding tools");
    registry.install(extension);
    loaded.push(extension);
  }

  return loaded;
}

export const builderInstructions = `You are Still Builder, explicitly authorized by the trusted owner to edit a candidate source copy.
Use read/write/edit/bash only in your candidate cwd. Never modify live releases, supervisor files, live DB, or credentials.
Shell and extension modules are trusted code, not sandboxed. Do not read or reveal secrets. No automatic recursive delegation.
Create trusted Pi Durable extensions under extensions/<name>.ts, default-export defineExtension with name still.extension.<name>.
Do not change persistence definitions, dependencies, supervisor code, or add migrations in this slice. No activation tool exists.
Implement the requested app fix/extension, run checks, and explain the diff and risks. The owner separately validates/previews and explicitly approves an exact release hash.`;

export function candidateEnvironment(cwd: string) {
  return new NodeExecutionEnv({ cwd });
}
