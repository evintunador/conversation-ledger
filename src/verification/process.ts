import { spawn } from "node:child_process";

// Only subprocesses created by this verification module are registered. Avoid
// leaving detached native process groups running when a scheduler cancels Node.
const cancellation = new Set<() => void>();
let listening = false;
const onInterrupt = () => cancel("SIGINT");
const onTerminate = () => cancel("SIGTERM");
function detachSignals(): void {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  listening = false;
}
function cancel(signal: "SIGINT" | "SIGTERM"): void {
  for (const cleanup of [...cancellation]) { try { cleanup(); } catch { /* already exited */ } }
  detachSignals();
  // Adding a listener suppresses Node's default signal exit. Restore it when
  // no application handler owns that signal; do not remove unrelated handlers.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}
export function registerVerificationCleanup(cleanup: () => void): () => void {
  cancellation.add(cleanup);
  if (!listening) {
    process.prependListener("SIGINT", onInterrupt);
    process.prependListener("SIGTERM", onTerminate);
    listening = true;
  }
  return () => {
    cancellation.delete(cleanup);
    if (!cancellation.size) detachSignals();
  };
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Bounded output and process-group lifetime; never inherits stdin or credentials. */
export async function runProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } } };
    const unregister = registerVerificationCleanup(kill);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
    child.stdout.on("data", (b: Buffer) => { stdout = (stdout + b.toString()).slice(-2_000_000); });
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-100_000); });
    child.on("error", (error) => { unregister(); clearTimeout(timer); options.signal?.removeEventListener("abort", kill); reject(error); });
    child.on("close", (code) => { unregister(); clearTimeout(timer); options.signal?.removeEventListener("abort", kill); kill(); resolve({ code, stdout, stderr, timedOut }); });
  });
}

export function isolatedEnvironment(root: string, path: string): NodeJS.ProcessEnv {
  return {
    PATH: path, HOME: root, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`,
    XDG_CACHE_HOME: `${root}/cache`, XDG_STATE_HOME: `${root}/state`, TMPDIR: `${root}/tmp`,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Verification", GIT_AUTHOR_EMAIL: "verification@example.invalid",
    GIT_COMMITTER_NAME: "Verification", GIT_COMMITTER_EMAIL: "verification@example.invalid",
    CI: "1", NO_COLOR: "1", TERM: "dumb", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_SHARE: "true",
  };
}
