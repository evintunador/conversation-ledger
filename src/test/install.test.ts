import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installClaudeCode,
  installCodex,
  installOpenInterpreter,
  installGeminiCli,
  installOpencode,
  installQwenCode,
  installPi,
  installMistralVibe,
  installCopilot,
  installKimi,
  installGoose,
  installDroid,
} from "../install.js";

/** Neither default nor overridden roots may point at real user configuration. */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "cledger-install-"));
  const keys = ["HOME", "INTERPRETER_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "GEMINI_CLI_HOME", "VIBE_HOME", "COPILOT_HOME", "KIMI_CODE_HOME", "GOOSE_PATH_ROOT", "FACTORY_HOME_OVERRIDE"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test("install: Claude and Codex use their configured roots without changing default config", async () => {
  await withTempHome(async (home) => {
    const claudeRoot = join(home, "isolated claude");
    const codexRoot = join(home, "isolated codex");
    process.env["CLAUDE_CONFIG_DIR"] = claudeRoot;
    process.env["CODEX_HOME"] = codexRoot;
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    const originalClaude = '{"theme":"dark"}\n';
    const originalCodex = 'model = "existing-model"\n';
    await writeFile(join(home, ".claude", "settings.json"), originalClaude);
    await writeFile(join(home, ".codex", "config.toml"), originalCodex);

    await installClaudeCode();
    await installCodex();
    assert.equal(await hookTimeout(join(claudeRoot, "settings.json"), "Stop"), 120);
    assert.match(await readFile(join(codexRoot, "config.toml"), "utf8"), /hook codex/);
    assert.equal(await readFile(join(home, ".claude", "settings.json"), "utf8"), originalClaude);
    assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), originalCodex);
    assert.match(await installClaudeCode(), /already installed/);
    assert.match(await installCodex(), /already installed/);
  });
});

test("new native installers preserve other configuration, honor roots and reinstall idempotently", async () => {
  await withTempHome(async (home) => {
    const vibe = join(home, "vibe"), kimi = join(home, "kimi"), copilot = join(home, "copilot");
    process.env["VIBE_HOME"] = vibe;
    process.env["KIMI_CODE_HOME"] = kimi;
    process.env["COPILOT_HOME"] = copilot;
    process.env["GEMINI_CLI_HOME"] = join(home, "gemini-parent");
    await Promise.all([vibe, kimi, join(copilot, "hooks")].map(path => mkdir(path, { recursive: true })));
    const otherHook = '[[hooks]]\nname = "other"\ntype = "post_agent"\ncommand = "echo preserved"\n';
    const kimiConfig = 'default_model = "existing"\n[providers.existing]\nbase_url = "https://example.invalid/v1"\n';
    await writeFile(join(vibe, "hooks.toml"), otherHook);
    await writeFile(join(kimi, "config.toml"), kimiConfig);
    await writeFile(join(copilot, "hooks", "other.json"), '{"version":1}\n');
    await installMistralVibe(); await installKimi(); await installCopilot(); await installGeminiCli();
    const vibeHooks = await readFile(join(vibe, "hooks.toml"), "utf8");
    assert.ok(vibeHooks.startsWith(otherHook));
    assert.equal((vibeHooks.match(/type = "post_agent"/g) ?? []).length, 2);
    const kimiHooks = await readFile(join(kimi, "config.toml"), "utf8");
    assert.ok(kimiHooks.startsWith(kimiConfig));
    assert.equal((kimiHooks.match(/\[\[hooks\]\]/g) ?? []).length, 4);
    assert.ok(!kimiHooks.includes('name = "conversation-ledger"'), "Kimi rejects extra hook fields");
    const copilotHooks = JSON.parse(await readFile(join(copilot, "hooks", "cledger.json"), "utf8"));
    assert.equal(copilotHooks.version, 1);
    assert.equal(copilotHooks.hooks.sessionEnd[0].args.at(-1), "--session-end");
    assert.equal(copilotHooks.hooks.agentStop[0].exec, process.execPath);
    assert.deepEqual(copilotHooks.hooks.agentStop[0].args.slice(-2), ["hook", "copilot"]);
    assert.equal(await readFile(join(copilot, "hooks", "other.json"), "utf8"), '{"version":1}\n');
    assert.equal(await hookTimeout(join(home, "gemini-parent", ".gemini", "settings.json"), "AfterAgent"), 120000);
    for (const install of [installMistralVibe, installKimi, installCopilot]) assert.match(await install(), /already installed/);
    await writeFile(join(kimi, "config.toml"), kimiHooks.replace("# <<< conversation-ledger kimi", ""));
    await assert.rejects(installKimi, /incomplete managed block/);
    assert.equal(await readFile(join(kimi, "config.toml"), "utf8"), kimiHooks.replace("# <<< conversation-ledger kimi", ""));
  });
});

test("Pi extension awaits native lifecycle capture and honors its configured root", async () => {
  await withTempHome(async (home) => {
    const originalPath = process.env.PATH;
    try {
      const bin = join(home, "bin");
      const agentRoot = join(home, "pi agent");
      const payloads = join(home, "payloads.jsonl");
      await mkdir(bin);
      await writeFile(join(bin, "cledger"), `#!${process.execPath}\nif(process.argv[2]==="--version") process.exit(0);\nlet input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>require("node:fs").appendFileSync(${JSON.stringify(payloads)},input+"\\n"));\n`, { mode: 0o755 });
      process.env.PATH = `${bin}:${originalPath ?? ""}`;
      process.env["PI_CODING_AGENT_DIR"] = agentRoot;
      await installPi();
      const body = await readFile(join(agentRoot, "extensions", "cledger.ts"), "utf8");
      type Handler = (event: unknown, context: { cwd: string; sessionManager: { getSessionFile(): string | undefined } }) => Promise<void>;
      const handlers = new Map<string, Handler>();
      const extension = await import(`data:text/javascript;base64,${Buffer.from(body).toString("base64")}`);
      extension.default({ on: (name: string, handler: Handler) => handlers.set(name, handler) });
      assert.ok(handlers.has("agent_end"));
      assert.ok(handlers.has("agent_settled"));
      assert.ok(handlers.has("session_shutdown"));
      const transcript = join(home, "session with ' quotes.jsonl");
      const context = { cwd: home, sessionManager: { getSessionFile: () => transcript } };
      await Promise.all([handlers.get("agent_end")!({}, context), handlers.get("session_shutdown")!({}, context)]);
      await handlers.get("agent_settled")!({}, { cwd: home, sessionManager: { getSessionFile: () => undefined } });
      const lines = (await readFile(payloads, "utf8")).trim().split("\n").map(s => JSON.parse(s));
      assert.deepEqual(lines, [{ transcript_path: transcript, cwd: home }, { transcript_path: transcript, cwd: home }]);
      assert.match(await installPi(), /already installed/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

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

test("install: the opencode plugin visibly warns only when it must discover a session", async () => {
  await withTempHome(async (home) => {
    const originalConfigHome = process.env["XDG_CONFIG_HOME"];
    const originalPath = process.env.PATH;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    try {
      process.env["XDG_CONFIG_HOME"] = home;
      const bin = join(home, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "cledger"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.PATH = `${bin}:${originalPath ?? ""}`;
      console.warn = (...args: unknown[]): void => {
        warnings.push(args.map(String).join(" "));
      };

      await installOpencode();
      const pluginPath = join(home, "opencode", "plugin", "cledger.js");
      const pluginSource = await readFile(pluginPath, "utf8");
      const pluginUrl = `data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`;
      const plugin = (await import(pluginUrl)) as {
        server(context: { directory: string; worktree: string }): Promise<{
          event(input: { event: unknown }): Promise<void>;
        }>;
      };
      const hooks = await plugin.server({ directory: home, worktree: home });

      await hooks.event({
        event: { type: "session.idle", properties: { renamedID: "TOP-SECRET" } },
      });
      assert.deepEqual(warnings, [
        "cledger: opencode plugin warning: session.idle provided no session id; " +
          "falling back to the project's most recently updated session",
      ]);
      assert.doesNotMatch(warnings[0]!, /TOP-SECRET/, "the warning must not echo event content");

      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: "ses_normal" } },
      });
      assert.equal(warnings.length, 1, "the normal hook path stays quiet");
    } finally {
      console.warn = originalWarn;
      if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});


test("Goose user plugin uses its isolated root and keeps neighboring plugins", async () => {
  await withTempHome(async home => {
    process.env.GOOSE_PATH_ROOT = join(home, "goose root");
    const plugins = join(process.env.GOOSE_PATH_ROOT, ".agents", "plugins");
    await mkdir(plugins, { recursive: true });
    await writeFile(join(plugins, "neighbor.txt"), "unchanged");
    await installGoose();
    const hooks = JSON.parse(await readFile(join(plugins, "conversation-ledger", "hooks", "hooks.json"), "utf8"));
    assert.ok(hooks.hooks.Stop[0].hooks[0].command.includes("hook goose"));
    assert.ok(hooks.hooks.SessionEnd[0].hooks[0].command.includes("hook goose"));
    assert.equal(await readFile(join(plugins, "neighbor.txt"), "utf8"), "unchanged");
    assert.match(await installGoose(), /already installed/);
  });
});


test("Droid preserves unrelated hooks and uses Factory's direct event map", async () => {
  await withTempHome(async home => {
    const root = join(home, "factory parent"); process.env.FACTORY_HOME_OVERRIDE = root;
    const path = join(root, ".factory", "hooks.json"); await mkdir(join(root, ".factory"), { recursive: true });
    const other = { hooks: [{ type: "command", command: "echo unrelated" }] };
    await writeFile(path, JSON.stringify({ Stop: [other] }));
    await installDroid();
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.hooks, undefined);
    assert.deepEqual(config.Stop[0], other);
    assert.ok(config.SessionEnd[0].hooks[0].command.includes("hook droid"));
    assert.match(await installDroid(), /already installed/);
  });
});


test("rollout hook installers enable only their scoped features and retain neighboring settings", async () => {
  await withTempHome(async home => {
    for (const [source, installer, directory] of [["codex", installCodex, ".codex"], ["open-interpreter", installOpenInterpreter, ".openinterpreter"]] as const) {
      const path = join(home, directory, "config.toml");
      await mkdir(join(home, directory), { recursive: true });
      const original = 'model = "TESTONLY-model"\n[other]\nhooks = true\n[features] # retained comment\nparallel = true\nhooks = false # explicit old setting\n[neighbor]\nvalue = "retained"\n';
      await writeFile(path, original);
      await installer();
      const text = await readFile(path, "utf8");
      assert.ok(text.includes('[features] # retained comment\nparallel = true\nhooks = true # explicit old setting'));
      assert.ok(text.includes('[neighbor]\nvalue = "retained"'));
      assert.ok(text.includes(`hook ${source}`));
      assert.match(await installer(), /already installed/);
      assert.equal(await readFile(path, "utf8"), text);
      await writeFile(path, '[features]');
      await installer();
      assert.equal(((await readFile(path, "utf8")).match(/\[features\]/g) ?? []).length, 1);
      assert.match(await readFile(path, "utf8"), /\[features\]\nhooks = true/);
    }
  });
});

test("rollout installers distinguish root dotted features from neighboring table keys", async () => {
  await withTempHome(async home => {
    for (const [installer, directory] of [[installCodex, ".codex"], [installOpenInterpreter, ".openinterpreter"]] as const) {
      const path = join(home, directory, "config.toml"); await mkdir(join(home, directory), { recursive: true });
      const neighbor = '[other]\nfeatures.hooks = false\n';
      await writeFile(path, neighbor); await installer();
      const installed = await readFile(path, "utf8");
      assert.ok(installed.startsWith(neighbor)); assert.match(installed, /\[features\]\nhooks = true/);
      assert.match(await installer(), /already installed/);
      for (const root of ['features.hooks = false # TESTONLY\n', 'features.parallel = true\n']) {
        await writeFile(path, root + neighbor); await installer();
        const text = await readFile(path, "utf8");
        assert.match(text.split('[other]')[0]!, /features.hooks = true/);
        assert.ok(text.includes(neighbor)); assert.doesNotMatch(text, /\[features\]/);
        assert.match(await installer(), /already installed/);
      }
      for (const unsupported of ['features.hooks = "false"\n', '[features]\nhooks = "false"\n', 'features = { hooks = false }\n', '["features"]\nhooks = false\n']) {
        await writeFile(path, unsupported);
        await assert.rejects(installer(), /features/);
        assert.equal(await readFile(path, "utf8"), unsupported, "unsupported config stays untouched");
      }
    }
  });
});
