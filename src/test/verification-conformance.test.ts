import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentEvidence, geminiBootstrapOnlyBackfill, verifyCoreConformance, CONFORMANCE_CASES, CONFORMANCE_DRIVERS } from "../verification/conformance.js";
import type { EvidenceEvent } from "../schema.js";
test("Gemini bootstrap limitation refuses missing human, assistant, tool or active-stream records", () => {
  const event = (id: string, kind: string, content: unknown) => ({ id, kind, actor: { type: "system" }, producer: { source: "gemini-cli", session_id: "TESTONLY-bootstrap" }, stream: { id: "TESTONLY-bootstrap" }, content }) as EvidenceEvent;
  const stamp = "2026-10-05T01:00:00Z";
  const bootstrap = [event("1", "session_state", { state_type: "metadata", sessionId: "TESTONLY-bootstrap", kind: "main", startTime: stamp, lastUpdated: stamp }), event("2", "session_state", { state_type: "metadata", lastUpdated: stamp }),
    event("3", "conversation_turn", { blocks: [{ type: "text", text: "<session_context>\nThis is the Gemini CLI.\nTESTONLY" }] })];
  assert.equal(geminiBootstrapOnlyBackfill([], bootstrap), true);
  assert.equal(geminiBootstrapOnlyBackfill([bootstrap[0]!], bootstrap), false);
  assert.equal(geminiBootstrapOnlyBackfill([], [...bootstrap, event("4", "activity", {})]), false);
  for (const actor of ["human", "agent"]) assert.equal(geminiBootstrapOnlyBackfill([], bootstrap.map(e => ({ ...e, actor: { type: actor } }) as EvidenceEvent)), false);
  assert.equal(geminiBootstrapOnlyBackfill([], bootstrap.map(e => e.id === "3" ? event("3", "conversation_turn", { blocks: [{ type: "tool_result" }] }) : e)), false);
});
test("image proof finds nested native result references and refuses embedded binary leftovers", () => {
  const reference = { type: "attachment_reference", sha256: "TESTONLY-digest", size: 68 };
  assert.deepEqual(attachmentEvidence({ blocks: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", data: reference } }] }] }), { references: 1, embeddedBinary: false });
  assert.deepEqual(attachmentEvidence([{ source: { type: "base64", data: "TESTONLY-binary" } }, reference]), { references: 1, embeddedBinary: true });
  assert.deepEqual(attachmentEvidence({ file: { type: "image/png", base64: "TESTONLY" } }), { references: 0, embeddedBinary: true });
  assert.deepEqual(attachmentEvidence("data:image/png;base64,TESTONLY"), { references: 0, embeddedBinary: true });
  assert.deepEqual(attachmentEvidence({ text: "image-TESTONLY.png" }), { references: 0, embeddedBinary: false });
  assert.deepEqual(attachmentEvidence({ imageUrl: { url: "kimi-file://f_762e3407-ba87-4622-a100-101e0554feb9" } }), { references: 1, embeddedBinary: false });
  assert.deepEqual(attachmentEvidence({ imageUrl: { url: "https://example.invalid/image.png" } }), { references: 0, embeddedBinary: false });
});
test("Cursor's pending native TUI cannot inherit headless certification", async () => {
  const report = await verifyCoreConformance("cursor", { mode: "interactive" });
  assert.equal(report.status, "blocked");
  assert.equal(report.requests, 0);
  assert.ok(Object.values(report.cases).every(result => result.status === "not-run"));
});
for (const cli of CONFORMANCE_DRIVERS) for (const mode of (cli === "cursor" ? ["headless"] as const : ["headless", "interactive"] as const)) {
  const variable = "CLEDGER_CONFORMANCE_" + cli.replaceAll("-", "_").toUpperCase() + "_BINARY";
  test(`${cli} installed ${mode} exercises multiline Unicode, linked read failure, text/image retention and resume`, { skip: !process.env[variable], timeout: 300000 }, async () => {
    const report = await verifyCoreConformance(cli, { binary: process.env[variable]!, mode,
      ...(cli === "opencode" && process.env.CLEDGER_CONFORMANCE_OPENCODE_RIPGREP === "1" ? { fileSearchBackend: "ripgrep" as const } : {}) });
    if (process.env.CLEDGER_CONFORMANCE_REPORT_DIRECTORY) {
      await mkdir(process.env.CLEDGER_CONFORMANCE_REPORT_DIRECTORY, { recursive: true });
      await writeFile(join(process.env.CLEDGER_CONFORMANCE_REPORT_DIRECTORY, cli + "-" + mode + ".json"), JSON.stringify(report, null, 2) + "\n");
    }
    for (const name of CONFORMANCE_CASES) {
      if (cli === "gemini-cli" && name === "backfill") {
        assert.ok(["pass", "limitation"].includes(report.cases[name]?.status ?? ""), JSON.stringify(report));
        continue;
      }
      const limitation = name === "imageReference" && ["continue", "mistral-vibe"].includes(cli) ||
        name === "userImageEntry" && (["goose", "openhands"].includes(cli) || mode === "headless" && ["kimi", "continue", "mistral-vibe", "cline", "crush", "cursor"].includes(cli)) ||
        (cli === "aider" || cli === "cline" && mode === "headless") && name === "resume";
      assert.equal(report.cases[name]?.status, limitation ? "limitation" : "pass", JSON.stringify(report));
    }
    assert.equal(report.mode, mode);
    assert.equal(report.status, "pass", JSON.stringify(report));
  });
}
