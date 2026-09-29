import { test } from "node:test";
import assert from "node:assert/strict";
import { runPty } from "../verification/pty.js";

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
