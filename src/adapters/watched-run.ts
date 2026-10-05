import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

/** Bounded capture worker; exposed for subprocess lifecycle regression checks. */
export function runCaptureWorker(command: string, args: string[], cwd: string, source: string, timeoutMs = 30_000): Promise<void> {
  return new Promise(done => {
    const worker = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
    let finished = false;
    const finish = (reason?: string) => {
      if (finished) return;
      finished = true; clearTimeout(deadline);
      // The leader can exit while unref'ed descendants keep running. Our
      // deadline must bound the entire owned group even after a normal exit.
      if (worker.pid) { try { process.kill(-worker.pid, "SIGKILL"); } catch { /* Group already gone. */ } }
      if (reason) process.stderr.write(`cledger: ${source} capture ${reason}; native source retained for backfill\n`);
      done();
    };
    const deadline = setTimeout(() => {
      finish(`exceeded its ${timeoutMs}-millisecond deadline`);
    }, timeoutMs);
    worker.once("error", () => finish("could not start"));
    worker.once("close", code => finish(code === 0 ? undefined : `failed (exit ${code})`));
  });
}

/** Observe native files only while this explicit invocation is alive. Capture
 * runs in its own bounded process group so a stuck Git subprocess cannot keep
 * the user's terminal wrapper alive indefinitely after the coding CLI exits.
 */
export async function runWatchedCli(
  binary: string, args: string[], source: string, captureArgs = ["--all"],
  captureCwd = process.cwd(), beforeExit?: () => Promise<void>,
): Promise<number> {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(binary, args, { stdio: "inherit", cwd: process.cwd() });
  let active = false, pending = Promise.resolve();
  const observe = () => {
    if (active) return;
    active = true;
    pending = runCaptureWorker(process.execPath, [cli, "capture", source, ...captureArgs], captureCwd, source)
      .finally(() => { active = false; });
  };
  const timer = setInterval(observe, 500);
  const interrupt = () => { child.kill("SIGINT"); }, terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((done, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal }));
    });
    clearInterval(timer); await pending; observe(); await pending;
  } finally {
    clearInterval(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
    await pending;
    await beforeExit?.();
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 128 + (constants.signals[result.signal] ?? 0);
  }
  return result.code ?? 1;
}
