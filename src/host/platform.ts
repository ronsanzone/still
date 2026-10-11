import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Stable for a process lifetime, not a PID alone. Darwin ps has second precision;
// the supervisor also owns an exclusive app account and cleans it before recovery.
export async function processStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("A positive process ID is required");

  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    });

    if (stat === null) return null;
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];

    if (!started) throw new Error("Cannot parse process start time");

    return started;
  }

  if (process.platform === "darwin") {
    const result = await execute(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      },
    ).catch((error) => {
      if (error.code === 1 && !error.stdout && !error.stderr) return null;
      throw error;
    });

    return result?.stdout.trim() || null;
  }

  throw new Error("Supervisor process control requires macOS or Linux");
}

// Caller must reserve the account exclusively for this host. This is cleanup,
// not containment: shell/preview code still has the app account's permissions.
export async function killAllOf(uid: number): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid === process.getuid?.())
    throw new Error("Refusing to kill root, invalid, or supervisor identity");

  if (process.platform === "darwin") {
    await execute("/usr/bin/pkill", ["-KILL", "-U", String(uid)]).catch(
      (error) => {
        // pkill's documented exit 1 means no processes matched, not a failure.
        if (error.code !== 1) throw error;
      },
    );

    return;
  }

  if (process.platform !== "linux")
    throw new Error("Supervisor process control requires macOS or Linux");

  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;

    const info = await lstat(`/proc/${pid}`).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    });

    if (info?.uid !== uid) continue;

    try {
      process.kill(Number(pid), "SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  }
}
