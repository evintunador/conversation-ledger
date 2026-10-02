/** Bounded per-session follower for the manifest write after SessionShutdown. */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepo, sha256Hex } from "annals";
import { captureClineTranscript } from "./cline.js";
export const CLINE_TAIL_DIRECTORY = "cledger-cline-tail";
interface TailTiming {
  initialDeadlineMs?: number;
  interactiveDeadlineMs?: number;
  settleMs?: number;
  pollMs?: number;
  exitGraceMs?: number;
}
export async function scheduleClineTail(
  directory: string,
  cwd: string,
): Promise<void> {
  const repo = await findRepo(cwd);
  if (!repo) return;
  const base = join(repo.commonDir, CLINE_TAIL_DIRECTORY);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const key = sha256Hex(resolve(directory)),
    lock = join(base, key + ".lock"),
    status = join(base, key + ".json");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const owner = JSON.parse(
        await readFile(join(lock, "owner.json"), "utf8"),
      );
      try {
        process.kill(owner.pid, 0);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") return;
      }
    } catch {
      if (Date.now() - (await stat(lock)).mtimeMs < 15_000) return;
    }
    await rm(lock, { recursive: true, force: true });
    try {
      await mkdir(lock);
    } catch {
      return;
    }
  }
  await writeFile(status, JSON.stringify({ status: "running" }), {
    mode: 0o600,
  });
  try {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--cline-tail",
        directory,
        cwd,
        lock,
        status,
      ],
      { cwd, detached: true, stdio: "ignore" },
    );
    await new Promise<void>((done, fail) => {
      child.once("spawn", done);
      child.once("error", fail);
    });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: child.pid }),
      { mode: 0o600 },
    );
    child.unref();
  } catch (error) {
    await writeFile(
      status,
      JSON.stringify({ status: "failed", reason: "spawn failed" }),
      { mode: 0o600 },
    );
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
}
export async function runClineTail(
  directory: string,
  cwd: string,
  lock: string,
  status: string,
  timing: TailTiming = {},
): Promise<void> {
  const save = (state: string, reason?: string) =>
    writeFileSync(
      status,
      JSON.stringify({
        status: state,
        pid: process.pid,
        ...(reason ? { reason } : {}),
      }),
      { mode: 0o600 },
    );
  const initialDeadlineMs = timing.initialDeadlineMs ?? 7_000;
  const interactiveDeadlineMs = timing.interactiveDeadlineMs ?? 12 * 60 * 60_000;
  const settleMs = timing.settleMs ?? 500;
  const exitGraceMs = timing.exitGraceMs ?? 5_000;
  const hard = setTimeout(() => {
    try {
      save("failed", "hard deadline");
    } catch {}
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  }, Math.max(initialDeadlineMs, interactiveDeadlineMs) + 10_000);
  try {
    const started = Date.now();
    let previous = "",
      stableSince = started,
      interactivePid: number | undefined,
      deadSince: number | undefined;
    while (Date.now() < started + (interactivePid ? interactiveDeadlineMs : initialDeadlineMs)) {
      const files = (await readdir(directory).catch(() => []))
        .filter((f) => f.endsWith(".json"))
        .sort();
      let terminal = false;
      const facts = [];
      for (const file of files) {
        const path = join(directory, file),
          bytes = await readFile(path, "utf8").catch(() => "");
        facts.push(file + sha256Hex(bytes));
        if (
          !file.endsWith(".messages.json") &&
          !file.endsWith(".compaction.json")
        ) {
          try {
            const m = JSON.parse(bytes);
            if (
              m.interactive === true &&
              Number.isSafeInteger(m.pid) &&
              m.pid > 0
            ) interactivePid = m.pid;
            terminal ||=
              typeof m.ended_at === "string" &&
              ["completed", "failed", "cancelled", "aborted"].includes(
                m.status,
              );
          } catch {}
        }
      }
      const current = facts.join("\n");
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
      }
      if (terminal && Date.now() - stableSince >= settleMs) {
        await captureClineTranscript(directory, cwd);
        save("complete");
        return;
      }
      if (interactivePid && !terminal) {
        try {
          process.kill(interactivePid, 0);
          deadSince = undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            deadSince ??= Date.now();
        }
        // The manifest can be written shortly after the TUI process exits.
        if (deadSince && Date.now() - deadSince >= exitGraceMs) break;
      }
      await new Promise((done) =>
        setTimeout(done, timing.pollMs ?? (interactivePid ? 1_000 : 100)),
      );
    }
    await captureClineTranscript(directory, cwd);
    save("failed", interactivePid
      ? "interactive session ended without a settled terminal manifest"
      : "terminal manifest did not settle");
  } catch {
    save("failed", "tail capture failed");
  } finally {
    clearTimeout(hard);
    await rm(lock, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--cline-tail"
) {
  const [directory, cwd, lock, status] = process.argv.slice(3);
  if (!directory || !cwd || !lock || !status)
    throw Error("Missing tail arguments");
  await runClineTail(directory, cwd, lock, status);
}
