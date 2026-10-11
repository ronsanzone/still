import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { type Extension, type Registry } from "@earendil-works/pi-durable";
import { Schema } from "effect";

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
