import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyScriptedCline } from "../verification/cline.js";
import { verifyScriptedQwen } from "../verification/qwen-code.js";
import { verifyScriptedCopilot } from "../verification/copilot.js";
import { runtimeBinary } from "../verification/runtimes.js";
import { isolatedEnvironment, runProcess } from "../verification/process.js";

test("Cline provisioning selects the platform executable when its shared npm alias is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-cline-native-selection-"));
  try {
    const directory = join(root, "cline", "node_modules", "@cline", `cli-${process.platform}-${process.arch}`, "bin");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "cline"), '#!/bin/sh\nprintf "TESTONLY-native-runtime\\n"\n', { mode: 0o755 });
    const result = await runProcess(runtimeBinary(root, "cline", "cline"), ["--version"], {
      cwd: root, env: isolatedEnvironment(root, process.env.PATH ?? "/usr/bin:/bin"), timeoutMs: 5000,
    });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout.trim(), "TESTONLY-native-runtime");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an explicitly missing runtime never falls through to another CLI on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-runtime-selection-"));
  const bin = join(root, "bin"), previous = process.env.PATH;
  await mkdir(bin);
  try {
    for (const name of ["cline", "qwen", "copilot"]) {
      await writeFile(join(bin, name), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "TESTONLY-fallback-runtime\\n"; exit 0; fi\nexit 93\n', { mode: 0o755 });
    }
    process.env.PATH = `${bin}:${previous ?? "/usr/bin:/bin"}`;
    for (const verify of [verifyScriptedCline, verifyScriptedQwen, verifyScriptedCopilot]) {
      const report = await verify({ binary: join(root, "TESTONLY-missing-runtime") });
      assert.equal(report.status, "blocked", report.reason);
      assert.equal(report.version, undefined, "The unrelated PATH executable must never be used");
    }
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
