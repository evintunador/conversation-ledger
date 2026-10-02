import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPty } from "../verification/pty.js";

async function waitForTrace(path: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(text)) return text;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.fail("Live terminal trace did not become available before the deadline");
}

test("PTY exposes bounded raw terminal output before the run finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-pty-trace-"));
  const trace = join(root, "terminal.log"), release = join(root, "release");
  let running: Promise<unknown> | undefined;
  try {
    const resultPromise = runPty("python3", ["-c", "import sys; print('TESTONLY-OLD'+('x'*300000)+'\\x1b[32mREADY\\x1b[0m',flush=True); print('GOT:'+input(),flush=True)"], {
      cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 5000, transcriptPath: trace,
      actions: [{ waitFor: "READY", waitForPath: release, send: "TESTONLY-release\r" }],
    });
    running = resultPromise;
    let settled = false;
    void resultPromise.then(() => { settled = true; }, () => { settled = true; });
    const live = await waitForTrace(trace, /READY/);
    assert.equal(settled, false, "trace must be readable while the TUI is still waiting");
    assert.ok(Buffer.byteLength(live) <= 200000);
    assert.doesNotMatch(live, /TESTONLY-OLD/, "trace replaces old output rather than appending forever");
    assert.match(live, /\x1b\[32mREADY\x1b\[0m/, "trace retains terminal control sequences");
    await writeFile(release, "ready");
    const result = await resultPromise;
    assert.equal(result.code, 0);
    assert.equal(await readFile(trace, "utf8"), result.output);
  } finally {
    await running?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("PTY reports live trace write failures and cleans up its terminal process", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-pty-trace-error-"));
  const trace = join(root, "terminal.log"), release = join(root, "release");
  let running: Promise<unknown> | undefined;
  try {
    const resultPromise = runPty("python3", ["-c", "import os,time; print('READY PID='+str(os.getpid()),flush=True); input(); print('AFTER_INPUT',flush=True); time.sleep(30)"], {
      cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 5000, transcriptPath: trace,
      actions: [{ waitFor: "READY", waitForPath: release, send: "TESTONLY-release\r" }],
    });
    running = resultPromise;
    const rejection = assert.rejects(resultPromise, /PTY transcript write failed/);
    const live = await waitForTrace(trace, /READY PID=\d+/);
    const pid = Number(live.match(/PID=(\d+)/)![1]);
    await rm(trace);
    await mkdir(trace);
    await writeFile(release, "ready");
    await rejection;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await running?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("PTY provides actual terminal stdin and ordered prompt response", async () => {
  const result = await runPty(
    "python3",
    [
      "-c",
      "import sys; print('READY' if sys.stdin.isatty() else 'NO_TTY',flush=True); print('GOT:'+input(),flush=True)",
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, TERM: "xterm" },
      timeoutMs: 3000,
      actions: [{ waitFor: "READY", send: "TESTONLY-terminal-input\r" }],
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.actionsCompleted, 1);
  assert.match(result.output, /GOT:TESTONLY-terminal-input/);
});

test("PTY waits for native hook evidence even after the terminal stops printing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-pty-hook-"));
  const evidence = join(root, "hook-complete");
  try {
    const resultPromise = runPty("python3", ["-c", "print('READY',flush=True); print('GOT:'+input(),flush=True)"], {
      cwd: root, env: { PATH: process.env.PATH, TERM: "xterm" }, timeoutMs: 3000,
      actions: [{ waitFor: "READY", waitForPath: evidence, send: "TESTONLY-after-hook\r" }],
    });
    let settled = false;
    void resultPromise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(settled, false, "terminal input must remain pending until hook evidence appears");
    await writeFile(evidence, "complete");
    const result = await resultPromise;
    assert.equal(result.code, 0, result.output);
    assert.equal(result.actionsCompleted, 1);
    assert.match(result.output, /GOT:TESTONLY-after-hook/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PTY deadline stops blocked native process and does not pretend input occurred", async () => {
  const start = Date.now();
  const result = await runPty(
    "python3",
    ["-c", "import time; print('WRONG',flush=True); time.sleep(30)"],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 150,
      actions: [{ waitFor: "EXPECTED", send: "never\r" }],
    },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.actionsCompleted, 0);
  assert.ok(Date.now() - start < 3000);
});

test("PTY stops at a login prerequisite without waiting for deadline or sending a prompt", async () => {
  const result = await runPty("python3",
    ["-c", "import time; print('LOGIN_REQUIRED',flush=True); time.sleep(30)"], {
      cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 3000,
      stopWhen: "LOGIN_REQUIRED",
      actions: [{ waitFor: "LOGIN_REQUIRED", send: "TESTONLY-must-not-send\r" }],
    });
  assert.equal(result.timedOut, false);
  assert.equal(result.actionsCompleted, 0);
  assert.match(result.output, /LOGIN_REQUIRED/);
  assert.doesNotMatch(result.output, /TESTONLY-must-not-send/);
});

test("PTY answers terminal discovery without enabling extended keyboard input", async () => {
  const result = await runPty("python3", ["-c", String.raw`
import os,sys,tty,select,time
tty.setraw(0)
for query,reply in [(b'\x1b[6n',b'\x1b[1;1R'),(b'\x1b[?u',b'\x1b[?0u'),(b'\x1b[c',b'\x1b[?1;2c'),(b'\x1b]10;?\x1b\\',b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),(b'\x1b]11;?\x07',b'\x1b]11;rgb:0000/0000/0000\x1b\\')]:
 os.write(1,query[:2]);time.sleep(.03);os.write(1,query[2:])
 actual=b''
 while len(actual)<len(reply):
  assert select.select([0],[],[],1)[0], 'missing terminal reply'
  actual+=os.read(0,len(reply)-len(actual))
 assert actual==reply,(actual,reply)
os.write(1,b'TERMINAL_REPLIES_OK')
`], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 4000, actions: [] });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /TERMINAL_REPLIES_OK/);
});

test("PTY can leave capability negotiation to a CLI's own fallback without injecting terminal replies", async () => {
  const result=await runPty("python3",["-c", "import sys,tty,select; tty.setraw(sys.stdin.fileno()); print('\\x1b[c',end='',flush=True); ready,_,_=select.select([sys.stdin],[],[],0.15); print('UNEXPECTED_REPLY' if ready else 'NO_REPLY',flush=True); sys.exit(1 if ready else 0)"],{
    cwd:process.cwd(),env:{PATH:process.env.PATH},timeoutMs:2000,actions:[],answerTerminalQueries:false,
  });
  assert.equal(result.code,0,result.output);
  assert.match(result.output,/NO_REPLY/);
});
