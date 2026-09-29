import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { readFile, lstat, mkdir, open, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findRepo } from "annals";

/** One bounded worker per native session; never a home-wide watcher. */
export async function scheduleTailCapture(directory: string, cwd: string, source: string, modulePath: string): Promise<void> {
  const repo = await findRepo(cwd); if (!repo) return;
  const base = join(repo.commonDir, `cledger-${source}-tail`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(JSON.stringify(resolve(directory))).digest("hex"), lock = join(base, key + ".lock");
  const status = join(base, key + ".json"), log = join(base, key + ".log");
  try {
    const prior = JSON.parse(await readFile(status, "utf8")) as { status?: string; error?: string };
    if (prior.status === "failed") process.stderr.write(`cledger: previous ${source} tail capture failed: ${prior.error ?? "see log"} (${log})\n`);
  } catch { /* First worker has no status. */ }
  try { await mkdir(lock); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // A spawn or force-killed worker can leave its lock. Never remove a live
    // owner's lock; recover only dead/stale owners after startup grace.
    try {
      const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as { pid?: number };
      if (typeof owner.pid === "number") { try { process.kill(owner.pid, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; } }
      else if (Date.now() - (await lstat(lock)).mtimeMs < 15_000) return;
    } catch { if (Date.now() - (await lstat(lock)).mtimeMs < 15_000) return; }
    await rm(lock, { recursive: true, force: true });
    try { await mkdir(lock); } catch (e2) { if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return; throw e2; }
  }
  const errorFile = await open(log, "w", 0o600);
  await errorFile.chmod(0o600);
  try {
    const worker = spawn(process.execPath, [modulePath, "--cledger-tail", directory, cwd, lock, status], {
      cwd, detached: true, stdio: ["ignore", "ignore", errorFile.fd], env: process.env,
    });
    await new Promise<void>((resolveSpawn, reject) => { worker.once("spawn", resolveSpawn); worker.once("error", reject); });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: worker.pid, startedAt: Date.now() }), { mode: 0o600 });
    worker.unref();
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  finally { await errorFile.close(); }
}
export async function runTailCapture(lock: string, status: string, source: string, fingerprint: () => Promise<string>, capture: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  // Hard wall limit also kills any subprocesses in this worker's own process
  // group. Never inherit the hook's pipes: that would block native Stop.
  const hardStop = setTimeout(() => {
    try { writeFileSync(status, JSON.stringify({ status: "failed", pid: process.pid, error: "Tail worker exceeded 10-second deadline" }), { mode: 0o600 }); chmodSync(status, 0o600); } catch { /* stderr remains available */ }
    process.stderr.write(`cledger: ${source} tail worker exceeded 10-second deadline\n`);
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }, 10_000);
  let captures = 0, last = "", unchangedSince = started, settled = false;
  try {
    while (Date.now() - started < 8_000) {
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      const current = await fingerprint();
      if (current !== last) {
        last = current; unchangedSince = Date.now();
        await capture(); captures++;
        continue; // Recheck the fingerprint after capture itself may have taken time.
      }
      if (Date.now() - unchangedSince >= 1_000) { settled = true; break; }
    }
    if (!settled) throw new Error("Native session continued changing beyond bounded tail deadline");
    await writeFile(status, JSON.stringify({ status: "complete", pid: process.pid, captures, durationMs: Date.now() - started, finishedAt: new Date().toISOString() }), { mode: 0o600 });
    await chmod(status, 0o600);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cledger: ${source} tail capture failed: ${message}\n`);
    await writeFile(status, JSON.stringify({ status: "failed", pid: process.pid, error: message, finishedAt: new Date().toISOString() }), { mode: 0o600 });
    await chmod(status, 0o600);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardStop);
    // Log is reset for each worker and capped after capture; never accumulate
    // unbounded diagnostics across a long-lived session.
    const logPath = status.replace(/\.json$/, ".log");
    try {
      const file = await open(logPath, "r");
      try {
        const info = await file.stat();
        if (info.size > 65_536) {
          const tail = Buffer.alloc(65_536); await file.read(tail, 0, tail.length, info.size - tail.length);
          await writeFile(logPath, tail, { mode: 0o600 }); await chmod(logPath, 0o600);
        }
      } finally { await file.close(); }
    } catch { /* Missing diagnostic log must not hide worker status. */ }
    await rm(lock, { recursive: true, force: true });
  }
}
