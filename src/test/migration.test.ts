import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git } from "annals";
import { cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const execFileP = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/migrate-ev1-history.mjs", import.meta.url));
const LIVE = "refs/notes/conversation-ledger";
const ARCHIVE = "refs/notes/conversation-ledger-ev1";
const CANDIDATE = "refs/notes/conversation-ledger-migration";

test("ev1 migration is additive, remaps event links, dedups converged identities, and reruns safely", async () => {
  const repo = await makeTempRepo("cledger-migrate-");
  try {
    const anchor = await makeCommit(repo, "anchor");
    const base = {
      schema: "conversation-ledger/v1",
      kind: "conversation_turn",
      occurred_at: "2026-01-01T00:00:00.000Z",
      recorded_at: "2026-01-01T00:00:01.000Z",
      content: { text: "same fact" },
      conversation: { id: "claude-code:old", seq: 0 },
    };
    const first = {
      ...base,
      id: "ev1-first",
      actor: { type: "human", id: "one@example.com" },
      producer: { tool: "cledger", source: "claude-code", session_id: "one" },
    };
    // Distinct ev1 provenance intentionally converges under ev2 identity.
    const second = {
      ...base,
      id: "ev1-second",
      actor: { type: "human", id: "two@example.com" },
      producer: { tool: "cledger", source: "claude-code", session_id: "two" },
    };
    const redaction = {
      id: "ev1-redaction",
      schema: "conversation-ledger/v1",
      kind: "redaction",
      occurred_at: "2026-01-01T00:00:02.000Z",
      recorded_at: "2026-01-01T00:00:03.000Z",
      actor: { type: "human" },
      producer: { tool: "cledger" },
      content: { reason: "test" },
      conversation: { id: "claude-code:old", seq: 0 },
      links: [{ rel: "redacts", target: "ev1-first" }],
    };
    // Some ev2 records were written before the final producer-blind identity
    // rules settled. The migration normalizes those IDs too.
    const earlyEv2 = {
      id: "ev2-stale",
      schema: "annals/v1",
      kind: "conversation_turn",
      occurred_at: "2026-01-01T00:00:04.000Z",
      recorded_at: "2026-01-01T00:00:05.000Z",
      producer: { tool: "cledger" },
      meta: { actor: { type: "agent" }, source: "codex" },
      stream: { id: "codex:early", seq: 0 },
      content: { text: "early ev2" },
    };
    const body = [first, second, redaction, earlyEv2]
      .map((e) => JSON.stringify(e)).sort().join("\n") + "\n";
    await git(["notes", "--ref", "conversation-ledger", "add", "-F", "-", anchor], {
      cwd: repo.root,
      input: body,
    });
    const original = (await git(["rev-parse", LIVE], { cwd: repo.root })).trim();

    const dry = await execFileP(process.execPath, [SCRIPT, "--repo", repo.root]);
    assert.match(dry.stdout, /DRY-RUN/);
    assert.equal((await git(["rev-parse", "--verify", "--quiet", ARCHIVE], {
      cwd: repo.root, allowFailure: true,
    })).trim(), "", "dry run writes no refs");

    await execFileP(process.execPath, [SCRIPT, "--repo", repo.root, "--execute"]);
    assert.equal((await git(["rev-parse", ARCHIVE], { cwd: repo.root })).trim(), original);
    const live = (await git(["rev-parse", LIVE], { cwd: repo.root })).trim();
    assert.notEqual(live, original);
    assert.equal((await git(["rev-parse", CANDIDATE], { cwd: repo.root })).trim(), live);

    const migratedBody = await git(["notes", "--ref", "conversation-ledger", "show", anchor], {
      cwd: repo.root,
    });
    const events = migratedBody.trim().split("\n").map((line) => JSON.parse(line) as {
      id: string;
      schema: string;
      actor?: unknown;
      conversation?: unknown;
      stream?: { id: string };
      links?: Array<{ rel: string; target: string }>;
    });
    assert.equal(events.length, 3, "two old identities converge; early ev2 remains distinct");
    assert.ok(events.every((e) => e.schema === "annals/v1" && e.id.startsWith("ev2-")));
    assert.ok(events.every((e) => e.actor === undefined && e.conversation === undefined));
    assert.equal(events.filter((e) => e.stream?.id === "claude-code:old").length, 2);
    assert.equal(events.filter((e) => e.stream?.id === "codex:early").length, 1);
    const companion = events.find((e) => e.links?.[0]?.rel === "redacts");
    assert.ok(companion);
    assert.ok(companion.links![0]!.target.startsWith("ev2-"), "event link target was remapped");
    assert.ok(events.some((e) => e.id === companion.links![0]!.target));

    const manifest = join(repo.commonDir, "conversation-ledger", "migrations", "ev1-to-ev2.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { mapping: Record<string, string> };
    assert.equal(parsed.mapping["ev1-first"], parsed.mapping["ev1-second"]);
    assert.match(parsed.mapping["ev2-stale"]!, /^ev2-/);
    assert.notEqual(parsed.mapping["ev2-stale"], "ev2-stale");
    assert.equal((await stat(manifest)).mode & 0o777, 0o600);

    const rerun = await execFileP(process.execPath, [SCRIPT, "--repo", repo.root, "--execute"]);
    assert.match(rerun.stdout, /already migrated/);
  } finally {
    await cleanupRepo(repo);
  }
});
