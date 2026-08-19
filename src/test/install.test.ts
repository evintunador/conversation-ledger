import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeCode, installGeminiCli, installQwenCode } from "../install.js";

/**
 * `os.homedir()` reads $HOME on POSIX, which is the only seam these functions
 * offer — they write to fixed paths under the user's home by design.
 */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "cledger-install-"));
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

async function hookTimeout(path: string, event: string): Promise<number | undefined> {
  const settings = JSON.parse(await readFile(path, "utf8")) as {
    hooks: Record<string, { hooks: { command?: string; timeout?: number }[] }[]>;
  };
  for (const entry of settings.hooks[event] ?? []) {
    const hook = entry.hooks.find((h) => h.command?.includes("hook "));
    if (hook) return hook.timeout;
  }
  return undefined;
}

test("install: the hook timeout is written in each CLI's own unit", async () => {
  // Claude Code reads `timeout` as seconds; Gemini CLI and Qwen Code forked the
  // config format but pass the number straight to setTimeout, so theirs is
  // milliseconds. Writing 120 into their settings asks to be SIGTERMed after
  // 120ms — less than a cold capture takes — which killed capture mid-write on
  // almost every turn.
  await withTempHome(async (home) => {
    await installClaudeCode();
    await installGeminiCli();
    await installQwenCode();

    assert.equal(
      await hookTimeout(join(home, ".claude", "settings.json"), "Stop"),
      120,
      "claude-code reads seconds",
    );
    assert.equal(
      await hookTimeout(join(home, ".gemini", "settings.json"), "AfterAgent"),
      120_000,
      "gemini-cli reads milliseconds",
    );
    assert.equal(
      await hookTimeout(join(home, ".qwen", "settings.json"), "Stop"),
      120_000,
      "qwen-code reads milliseconds",
    );
  });
});

test("install: re-running repairs a hook left with the wrong timeout", async () => {
  // A user who installed a version that wrote 120ms must be able to fix it by
  // re-running install; the old code saw "a cledger hook exists" and did nothing.
  await withTempHome(async (home) => {
    const path = join(home, ".gemini", "settings.json");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          AfterAgent: [
            { hooks: [{ type: "command", command: "cledger hook gemini-cli", timeout: 120 }] },
          ],
          SessionEnd: [
            { hooks: [{ type: "command", command: "cledger hook gemini-cli", timeout: 120 }] },
          ],
        },
      }) + "\n",
    );

    const message = await installGeminiCli();
    assert.match(message, /timeout corrected/, "it reports what it repaired");
    assert.equal(await hookTimeout(path, "AfterAgent"), 120_000);
    assert.equal(await hookTimeout(path, "SessionEnd"), 120_000);

    const second = await installGeminiCli();
    assert.match(second, /already installed/, "and is idempotent once correct");
  });
});

async function hookCommandFor(path: string, event: string): Promise<string | undefined> {
  const settings = JSON.parse(await readFile(path, "utf8")) as {
    hooks: Record<string, { hooks: { command?: string; timeout?: number }[] }[]>;
  };
  for (const entry of settings.hooks[event] ?? []) {
    const hook = entry.hooks.find((h) => h.command?.includes("hook "));
    if (hook) return hook.command;
  }
  return undefined;
}

test("install: a hook command no longer discards the capture's output", async () => {
  // Gemini and Qwen hooks used to get ` >/dev/null 2>&1` appended, on the
  // theory that it detached the work from the CLI's teardown. It never did —
  // both CLIs run a hook as `bash -c`, which execs a single simple command
  // rather than forking. The hooks were dying of the timeout unit instead. All
  // the redirect achieved was hiding format-drift warnings.
  await withTempHome(async (home) => {
    await installGeminiCli();
    await installQwenCode();
    for (const [dir, event] of [
      [".gemini", "AfterAgent"],
      [".gemini", "SessionEnd"],
      [".qwen", "Stop"],
      [".qwen", "SessionEnd"],
    ] as const) {
      const command = await hookCommandFor(join(home, dir, "settings.json"), event);
      assert.ok(command, `${dir} ${event} has a cledger hook`);
      assert.doesNotMatch(command, /\/dev\/null/, `${dir} ${event} keeps its output`);
    }
  });
});

test("install: re-running strips the stale output redirect from an existing hook", async () => {
  // Same contract as the timeout repair: a setting cledger itself got wrong is
  // fixable by re-running install, not by hand-editing JSON.
  await withTempHome(async (home) => {
    const path = join(home, ".qwen", "settings.json");
    await mkdir(join(home, ".qwen"), { recursive: true });
    const stale = "cledger hook qwen-code >/dev/null 2>&1";
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: stale, timeout: 120_000 }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: stale, timeout: 120_000 }] }],
        },
      }) + "\n",
    );

    const message = await installQwenCode();
    assert.match(message, /output no longer discarded/, "it reports what it repaired");
    assert.equal(await hookCommandFor(path, "Stop"), "cledger hook qwen-code");
    assert.equal(await hookCommandFor(path, "SessionEnd"), "cledger hook qwen-code");
    assert.equal(await hookTimeout(path, "Stop"), 120_000, "a correct timeout is not disturbed");

    const second = await installQwenCode();
    assert.match(second, /already installed/, "and is idempotent once repaired");
  });
});

test("install: a redirect that is not cledger's own is left as written", async () => {
  // The repair matches one exact trailing string, so a user who routes the
  // hook's output somewhere deliberately keeps it.
  await withTempHome(async (home) => {
    const path = join(home, ".qwen", "settings.json");
    await mkdir(join(home, ".qwen"), { recursive: true });
    const mine = "cledger hook qwen-code >>/tmp/cledger.log 2>&1";
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: mine, timeout: 120_000 }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: mine, timeout: 120_000 }] }],
        },
      }) + "\n",
    );

    const message = await installQwenCode();
    assert.match(message, /already installed/, "nothing to repair");
    assert.equal(await hookCommandFor(path, "Stop"), mine);
  });
});

test("install: an unrelated hook in the same event is left alone", async () => {
  await withTempHome(async (home) => {
    const path = join(home, ".gemini", "settings.json");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          AfterAgent: [{ hooks: [{ type: "command", command: "my-own-thing", timeout: 5 }] }],
        },
      }) + "\n",
    );

    await installGeminiCli();
    const settings = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, { hooks: { command?: string; timeout?: number }[] }[]>;
    };
    const commands = settings.hooks["AfterAgent"]!.flatMap((e) => e.hooks);
    assert.ok(
      commands.some((h) => h.command === "my-own-thing" && h.timeout === 5),
      "someone else's hook keeps its own command and timeout",
    );
    assert.ok(commands.some((h) => h.command?.includes("hook gemini-cli")));
  });
});
