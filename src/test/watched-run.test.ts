import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCaptureWorker, runWatchedCli } from "../adapters/watched-run.js";

test("capture deadlines terminate descendant process groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cledger-watch-deadline-"));
  try {
    const path = join(dir, "pid");
    const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); require('node:fs').writeFileSync(${JSON.stringify(path)},String(child.pid)); setInterval(()=>{},1000);`;
    const start = Date.now();
    await runCaptureWorker(process.execPath, ["-e", script], dir, "TESTONLY", 500);
    assert.ok(Date.now() - start < 3000);
    const pid = Number(await readFile(path, "utf8"));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 50)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, "capture grandchild must not survive its deadline");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("wrapper retains native exit status and cleans up even on launch failure", async () => {
  let cleaned = 0;
  assert.equal(await runWatchedCli(process.execPath, ["-e", "process.exit(7)"], "TESTONLY-no-adapter", [], tmpdir(), async () => { cleaned++; }), 7);
  assert.equal(cleaned, 1);
  await assert.rejects(runWatchedCli("/TESTONLY-missing-native-cli", [], "TESTONLY", [], tmpdir(), async () => { cleaned++; }), /ENOENT/);
  assert.equal(cleaned, 2);
});

test("capture worker cleans orphan descendants when its leader exits before deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cledger-watch-orphan-"));
  let pid: number | undefined;
  try {
    const path = join(dir, "pid");
    const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(path)},String(child.pid)); child.unref();`;
    await runCaptureWorker(process.execPath, ["-e", script], dir, "TESTONLY", 500);
    pid = Number(await readFile(path, "utf8"));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 50)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, "normal leader completion cannot cancel descendant cleanup");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
    await rm(dir, { recursive: true, force: true });
  }
});
