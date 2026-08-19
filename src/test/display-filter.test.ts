/**
 * `log`/`show`/`conversations` hide session machinery by *actor*, not by kind.
 *
 * Hiding the four machinery kinds wholesale earns its keep against telemetry —
 * a session restates its mode and its token counts far more often than anyone
 * speaks — but it does not distinguish whose action a record was, so a slash
 * command the human typed was hidden by the same rule as a token-count ping.
 * These tests pin the line where it now sits: the human's gestures show, the
 * harness's and the agent's bookkeeping stays behind `--with-state`, and
 * nothing about what is *stored* changes either way.
 */
import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendEvents } from "../store.js";
import { cleanupRepo, draft, makeCommit, makeTempRepo } from "./helpers.js";
import type { RepoInfo } from "../git.js";
import type { EvidenceEvent } from "../schema.js";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/** One of each interesting (kind, actor) pair, plus an ordinary turn. */
const FIXTURE = [
  { label: "turn", kind: "conversation_turn", actor: "human" },
  { label: "slash-command", kind: "activity", actor: "human" },
  { label: "telemetry", kind: "activity", actor: "system" },
  { label: "agent-step", kind: "activity", actor: "agent" },
  { label: "mode-change", kind: "session_state", actor: "system" },
  { label: "at-command", kind: "context_injection", actor: "human" },
  { label: "bootstrap", kind: "context_injection", actor: "system" },
  { label: "file-history", kind: "file_snapshot", actor: "system" },
] as const;

async function seeded(): Promise<RepoInfo> {
  const repo = await makeTempRepo("cledger-display-");
  await makeCommit(repo);
  await appendEvents(
    repo,
    FIXTURE.map((f, i) =>
      draft({
        kind: f.kind,
        actor: { type: f.actor },
        occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        content: { role: f.actor, text: f.label },
        conversation: { id: "display-fixture", seq: i },
      }),
    ),
  );
  return repo;
}

/** Labels of the events `cledger log --json <args>` chose to display. */
async function shown(repo: RepoInfo, args: string[] = []): Promise<string[]> {
  const { stdout } = await execFileP(process.execPath, [CLI, "log", "--json", ...args], {
    cwd: repo.root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvidenceEvent)
    .map((e) => String((e.content as Record<string, unknown>)["text"]));
}

test("log: a machinery event the human drove shows by default", async () => {
  const repo = await seeded();
  try {
    const labels = await shown(repo);
    assert.deepEqual(
      [...labels].sort(),
      ["at-command", "slash-command", "turn"],
      "the human's gestures and the turn, and nothing the harness or agent logged",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("log: --with-state still reveals every machinery event", async () => {
  const repo = await seeded();
  try {
    const labels = await shown(repo, ["--with-state"]);
    assert.equal(labels.length, FIXTURE.length, "the flag's meaning is unchanged: show it all");
  } finally {
    await cleanupRepo(repo);
  }
});

test("log: --kind still opts in explicitly, whatever the actor", async () => {
  // Filtering to a kind and then hiding most of it would just return nothing.
  const repo = await seeded();
  try {
    const labels = await shown(repo, ["--kind", "activity"]);
    assert.deepEqual([...labels].sort(), ["agent-step", "slash-command", "telemetry"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("export stays lossless regardless of actor", async () => {
  // The display default is a display default. A consumer reading the ledger
  // must still see every record, which is the promise `export` makes.
  const repo = await seeded();
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, "export"], {
      cwd: repo.root,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(stdout.split("\n").filter(Boolean).length, FIXTURE.length);
  } finally {
    await cleanupRepo(repo);
  }
});

/**
 * `log`'s human format prints a position within the conversation, not the
 * stored `seq`.
 *
 * `seq` is an ordering key, and adapters derive it from whatever the source
 * makes stable — the opencode adapter takes it from the part id, a 48-bit
 * timestamp, which printed raw turns every row into `opencode:9f2a#67580218395`.
 * These seqs are the same shape.
 */
const BIG = [67580218395, 67580218396, 67580218400];

async function seededWithBigSeqs(): Promise<RepoInfo> {
  const repo = await makeTempRepo("cledger-ordinal-");
  await makeCommit(repo);
  await appendEvents(repo, [
    draft({
      kind: "conversation_turn",
      actor: { type: "human" },
      content: { role: "human", text: "first" },
      conversation: { id: "opencode:big", seq: BIG[0]! },
    }),
    // Harness bookkeeping, hidden by default — it must not consume a position.
    draft({
      kind: "activity",
      actor: { type: "system" },
      content: { role: "system", text: "telemetry" },
      conversation: { id: "opencode:big", seq: BIG[1]! },
    }),
    draft({
      kind: "conversation_turn",
      actor: { type: "agent" },
      content: { role: "agent", text: "second" },
      conversation: { id: "opencode:big", seq: BIG[2]! },
    }),
  ]);
  return repo;
}

async function logLines(repo: RepoInfo, args: string[] = []): Promise<string[]> {
  const { stdout } = await execFileP(process.execPath, [CLI, "log", ...args], {
    cwd: repo.root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split("\n").filter(Boolean);
}

test("log: a conversation position is printed, not a 48-bit ordering key", async () => {
  const repo = await seededWithBigSeqs();
  try {
    const lines = await logLines(repo);
    assert.equal(lines.length, 2, "only the two turns are shown by default");
    assert.ok(
      lines.every((l) => !l.includes(String(BIG[0]!))),
      `the raw seq must not appear:\n${lines.join("\n")}`,
    );
    assert.match(lines[0]!, /opencode:big#1\b/);
    assert.match(
      lines[1]!,
      /opencode:big#3\b/,
      "positions come from the full read, so hiding the telemetry between them does not renumber",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("log --json keeps the stored seq, because a machine wants the ordering key", async () => {
  const repo = await seededWithBigSeqs();
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, "log", "--json"], {
      cwd: repo.root,
      maxBuffer: 32 * 1024 * 1024,
    });
    const seqs = stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as EvidenceEvent).conversation!.seq);
    assert.deepEqual(seqs.sort((a, b) => a - b), [BIG[0]!, BIG[2]!]);
  } finally {
    await cleanupRepo(repo);
  }
});
