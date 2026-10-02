import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGooseTranscript, captureGooseAll, runGooseHook, renormalizeUnrecognizedMany } from "../adapters/goose.js";
import { eventId } from "../schema.js";
import { readEvents } from "../store.js";
import { cleanupDir, cleanupRepo, makeCommit, makeTempRepo } from "./helpers.js";

const START = "2026-09-28T12:00:00.000Z";
function message(id: string, content: unknown[], role = "assistant", metadata: Record<string, unknown> = {}) {
  return { id, role, created: 1790596800, content, metadata: { userVisible: true, agentVisible: true, ...metadata } };
}
function session(conversation: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "goose-test", session_type: "user", working_dir: "/fixture", created_at: START, updated_at: START,
    extension_data: {}, conversation, ...extra };
}

test("Goose covers all eleven current native content variants, roles, provider metadata and binary references", async () => {
  const repo = await makeTempRepo(); const dir = await mkdtemp(join(tmpdir(), "cledger-goose-"));
  try {
    await makeCommit(repo, "initial");
    const blocks = [
      { type: "text", text: "" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      { type: "document", mimeType: "text/plain", name: "note.txt", data: Buffer.from("Readable note").toString("base64") },
      { type: "toolRequest", id: "call", toolCall: { status: "success", value: { name: "shell", arguments: { command: "cat note.txt" } } }, metadata: { providerField: "visible" } },
      { type: "toolResponse", id: "call", toolResult: { status: "success", value: { content: [{ type: "text", text: "Tool output" }], isError: false } } },
      { type: "toolConfirmationRequest", id: "ask", toolName: "write", arguments: { path: "note.txt" } },
      { type: "actionRequired", data: { actionType: "elicitation", id: "ask", message: "Pick", requested_schema: { type: "string" } } },
      { type: "thinking", thinking: "Visible reasoning", signature: "signed-provider-state" },
      { type: "redactedThinking", data: "opaque-provider-state" },
      { type: "systemNotification", notificationType: "progressMessage", msg: "Working" },
      { type: "error", kind: "contextLengthExceeded", message: "Context full" },
    ];
    const messages = blocks.map((block, index) => message(`m${index}`, [block], index === 0 || index === 4 ? "user" : "assistant",
      { inference: { provider: "fixture-provider", requestedModel: "alias", resolvedModel: "actual-model" } }));
    const path = join(dir, "session.json");
    await writeFile(path, JSON.stringify(session(messages, { recipe: { extensions: [{ envs: { EXAMPLE_SECRET: "FAKE_TESTONLY_VALUE" } }] } })));
    const result = await captureGooseTranscript(path, repo.root);
    assert.equal(result.appended, 13); // metadata + eleven messages + opaque sibling
    assert.deepEqual(result.unrecognized, {});
    const events = (await readEvents(repo)).sort((a, b) => a.stream!.seq - b.stream!.seq);
    assert.equal(events.find((e) => (e.content as { id?: string }).id === "m0")!.actor.type, "human");
    assert.equal(events.find((e) => (e.content as { id?: string }).id === "m4")!.actor.type, "system");
    assert.match(JSON.stringify(events), /Readable note|attachment_reference/);
    assert.doesNotMatch(JSON.stringify(events), /iVBORw0KGgo=|FAKE_TESTONLY_VALUE/);
    assert.ok(events.filter((e) => e.stream!.seq > 0).every((e) => e.producer.model === "actual-model"));
    assert.ok(events.every((e) => e.producer.source_version === undefined));
    const sealed = events.find((e) => e.kind === "reasoning")!;
    const visible = events.find((e) => (e.content as { id?: string }).id === "m8")!;
    assert.ok(events.filter((e) => e.kind !== "reasoning").every((e) => !JSON.stringify(e).includes("opaque-provider-state")));
    assert.match(JSON.stringify(events), /Visible reasoning|signed-provider-state/);
    const upgraded = renormalizeUnrecognizedMany({ ...visible, kind: "unrecognized", raw: { format: visible.raw!.format, data: messages[8] } },
      { name: "Test User", email: "test@example.com" });
    assert.deepEqual(upgraded!.map(eventId).sort(), [visible.id, sealed.id].sort());
    assert.equal((await captureGooseTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Goose preserves all action variants, tool errors, composite provenance and invisible context", async () => {
  const repo = await makeTempRepo(); const dir = await mkdtemp(join(tmpdir(), "cledger-goose-control-"));
  try {
    await makeCommit(repo, "initial");
    const messages = [
      ...["toolConfirmation", "elicitation", "elicitationResponse", "toolConfirmationResponse"].map((actionType, index) => message(`a${index}`,
        [{ type: "actionRequired", data: { actionType, id: "action", futureField: "preserved" } }], "user")),
      message("failed-call", [{ type: "toolRequest", id: "bad", toolCall: { status: "error", error: "Invalid call" } }]),
      message("failed-result", [{ type: "text", text: "Mixed envelope" }, { type: "toolResponse", id: "bad", toolResult: { status: "error", error: "Denied" } }], "user"),
      message("context", [{ type: "text", text: "Harness context" }], "user", { turnContext: true, userVisible: false }),
      message("hidden-agent", [{ type: "thinking", thinking: "Agent reasoning", signature: "" }], "assistant", { userVisible: false }),
    ];
    const path = join(dir, "session.json"); await writeFile(path, JSON.stringify(session(messages, { session_type: "sub_agent", parent_session_id: "parent" })));
    assert.deepEqual((await captureGooseTranscript(path, repo.root)).unrecognized, {});
    const events = await readEvents(repo);
    assert.ok(events.every((event) => event.stream?.parent === "goose:parent"));
    assert.equal(events.find((event) => (event.content as { id?: string }).id === "failed-result")!.actor.type, "system");
    assert.equal(events.find((event) => (event.content as { id?: string }).id === "context")!.kind, "context_injection");
    assert.equal(events.find((event) => (event.content as { id?: string }).id === "hidden-agent")!.actor.type, "agent");
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Goose mutable exports retain survivor identity across rewind, changes and concurrent snapshots without a cursor", async () => {
  const repo = await makeTempRepo(); const dir = await mkdtemp(join(tmpdir(), "cledger-goose-rewind-"));
  try {
    await makeCommit(repo, "initial");
    const path = join(dir, "session.json");
    const messages = [message("first", [{ type: "text", text: "First" }], "user"), message("removed", [{ type: "text", text: "Old" }]), message("survivor", [{ type: "text", text: "Survives" }])];
    await writeFile(path, JSON.stringify(session(messages)));
    const results = await Promise.all([captureGooseTranscript(path, repo.root), captureGooseTranscript(path, repo.root)]);
    assert.equal(results.reduce((sum, result) => sum + result.appended, 0), 4);
    const before = (await readEvents(repo)).find((e) => (e.content as { id?: string }).id === "survivor")!;
    await writeFile(path, JSON.stringify(session([messages[0], messages[2]])));
    assert.equal((await captureGooseTranscript(path, repo.root)).appended, 1, "only changed native ordering metadata");
    assert.ok((await readEvents(repo)).some((e) => e.id === before.id));
    await writeFile(path, JSON.stringify(session([messages[0], message("survivor", [{ type: "text", text: "Edited" }])])));
    assert.equal((await captureGooseTranscript(path, repo.root)).appended, 1);
    assert.equal((await captureGooseTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Goose unknown blocks and malformed known shapes remain raw with drift warnings", async () => {
  const repo = await makeTempRepo(); const dir = await mkdtemp(join(tmpdir(), "cledger-goose-drift-"));
  try {
    await makeCommit(repo, "initial");
    const messages = [message("future", [{ type: "futureBlock", novel: "Preserve me" }]), message("malformed", [{ type: "text", text: { new: "shape" } }]),
      message("mixed", [{ type: "futureBlock", novel: "Future" }, { type: "redactedThinking", data: "opaque-drift-ciphertext" }])];
    const path = join(dir, "session.json"); await writeFile(path, JSON.stringify(session(messages)));
    const result = await captureGooseTranscript(path, repo.root);
    assert.equal(Object.values(result.unrecognized).reduce((a, b) => a + b, 0), 3);
    const raw = (await readEvents(repo)).filter((e) => e.kind === "unrecognized").map((e) => e.raw!.data);
    assert.deepEqual(raw.find((item) => (item as { id?: string }).id === "future"), messages[0]);
    const events = await readEvents(repo);
    assert.ok(events.filter((e) => e.kind !== "reasoning").every((e) => !JSON.stringify(e).includes("opaque-drift-ciphertext")));
    assert.match(JSON.stringify(events.find((e) => e.kind === "reasoning")), /opaque-drift-ciphertext/);
    assert.equal((await captureGooseTranscript(path, repo.root)).appended, 0);
  } finally { await cleanupRepo(repo); await cleanupDir(dir); }
});

test("Goose native discovery scopes cwd exactly, follows linked descendants and hooks resolve missing cwd", async () => {
  const repo = await makeTempRepo(); const dir = await mkdtemp(join(tmpdir(), "cledger-goose-discovery-"));
  const previousPath = process.env.PATH;
  try {
    await makeCommit(repo, "initial");
    const snapshots = [
      session([message("human", [{ type: "text", text: "Prompt" }], "user")], { id: "parent", working_dir: repo.root }),
      session([message("delegated", [{ type: "text", text: "Delegated prompt" }], "user")], { id: "child", parent_session_id: "parent", session_type: "sub_agent", working_dir: dir }),
      session([message("foreign", [{ type: "text", text: "Other project" }], "user")], { id: "foreign", working_dir: `${repo.root}-other` }),
    ];
    const log = join(dir, "calls.jsonl");
    await writeFile(join(dir, "goose"), `#!${process.execPath}\nconst fs=require('node:fs');const sessions=${JSON.stringify(snapshots)};const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[1]==='list'){process.stdout.write(JSON.stringify(sessions.map(({conversation,...s})=>s)));}else{const id=args[args.indexOf('--session-id')+1];process.stdout.write(JSON.stringify(sessions.find(s=>s.id===id)));}\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${previousPath ?? "/usr/bin:/bin"}`;
    assert.equal((await captureGooseAll(repo.root)).appended, 4);
    const events = await readEvents(repo);
    assert.ok(events.every((e) => e.producer.session_id !== "foreign"));
    const child = events.find((e) => e.producer.session_id === "child" && e.kind === "conversation_turn")!;
    assert.equal(child.actor.type, "system"); assert.equal(child.stream?.parent, "goose:parent");
    await runGooseHook(JSON.stringify({ event: "SessionEnd", session_id: "parent" }));
    assert.equal((await readEvents(repo)).length, 4);
    assert.doesNotMatch(await readFile(log, "utf8"), /--session-id","foreign/);
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await cleanupRepo(repo); await cleanupDir(dir); }
});
