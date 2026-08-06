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
