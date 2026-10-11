import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  lstat,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const roots = [
  "src",
  "test",
  "public",
  "tools",
  "deploy",
  "extensions",
  ".agents/skills",
];

const files = [
  "README.md",
  "AGENTS.md",
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "oxlint.config.ts",
];

// Positive source allowlist: no live DB, .env, credentials, git metadata or node_modules.
export async function sourceFiles(directory: string, built = false) {
  const found: string[] = [];

  async function visit(path: string) {
    const info = await lstat(join(directory, path)).catch(() => undefined);

    if (!info) return;

    if (info.isSymbolicLink())
      throw new Error(`Source symlinks are not supported: ${path}`);

    if (info.isDirectory()) {
      for (const name of (await readdir(join(directory, path))).sort()) {
        if (name.startsWith(".") || /\.(sqlite|db|pem|key)$/.test(name))
          throw new Error(
            `Private or hidden source file rejected: ${path}/${name}`,
          );
        await visit(join(path, name));
      }
    } else if (info.isFile()) found.push(path);
  }

  for (const path of [...roots, ...files, ...(built ? ["dist"] : [])])
    await visit(path);

  return found.sort();
}

export async function fingerprint(directory: string, built = false) {
  const hash = createHash("sha256");

  for (const file of await sourceFiles(directory, built)) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(directory, file)))
      .update("\0");
  }

  return hash.digest("hex");
}

export async function copySource(
  source: string,
  target: string,
  built = false,
) {
  await mkdir(target, { recursive: true });

  for (const file of await sourceFiles(source, built)) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(source, file), join(target, file));
  }
}

export async function permissions(
  directory: string,
  uid: number,
  gid: number,
  writable: boolean,
) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);

    if (info.isSymbolicLink()) continue;

    if (info.isDirectory()) await permissions(path, uid, gid, writable);
    else {
      await chown(path, uid, gid);
      await chmod(path, writable ? 0o644 : 0o444);
    }
  }

  await chown(directory, uid, gid);
  await chmod(directory, writable ? 0o755 : 0o555);
}

export async function atomicJson<A>(path: string, value: A) {
  const file = await open(`${path}.next`, "w", 0o600);

  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(`${path}.next`, path);
  const directory = await open(dirname(path), "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function sourceDiff(before: string, after: string) {
  const paths = new Set([
    ...(await sourceFiles(before)),
    ...(await sourceFiles(after)),
  ]);

  const changes: string[] = [];

  for (const path of paths) {
    const a = await readFile(join(before, path), "utf8").catch(() => "");
    const b = await readFile(join(after, path), "utf8").catch(() => "");

    if (a === b) continue;
    changes.push(
      `--- ${relative(before, join(before, path))}\n+++ ${path}\n${a
        .split("\n")
        .map((line) => `-${line}`)
        .join("\n")}\n${b
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}`,
    );
  }

  return changes.join("\n\n");
}
