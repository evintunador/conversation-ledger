import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentEvidence, verifyCoreConformance } from "../verification/conformance.js";
test("image proof finds nested native result references and refuses embedded binary leftovers", () => {
  const reference = { type: "attachment_reference", sha256: "TESTONLY-digest", size: 68 };
  assert.deepEqual(attachmentEvidence({ blocks: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", data: reference } }] }] }), { references: 1, embeddedBinary: false });
  assert.deepEqual(attachmentEvidence([{ source: { type: "base64", data: "TESTONLY-binary" } }, reference]), { references: 1, embeddedBinary: true });
  assert.deepEqual(attachmentEvidence({ file: { type: "image/png", base64: "TESTONLY" } }), { references: 0, embeddedBinary: true });
  assert.deepEqual(attachmentEvidence("data:image/png;base64,TESTONLY"), { references: 0, embeddedBinary: true });
  assert.deepEqual(attachmentEvidence({ text: "image-TESTONLY.png" }), { references: 0, embeddedBinary: false });
});
for (const cli of ["claude-code", "codex", "opencode"] as const) {
  const variable = "CLEDGER_CONFORMANCE_" + cli.replaceAll("-", "_").toUpperCase() + "_BINARY";
  test(`${cli} installed TUI exercises multiline Unicode, linked read failure, text/image retention and resume`, { skip: !process.env[variable] }, async () => {
    const report = await verifyCoreConformance(cli, { binary: process.env[variable]!,
      ...(cli === "opencode" && process.env.CLEDGER_CONFORMANCE_OPENCODE_RIPGREP === "1" ? { fileSearchBackend: "ripgrep" as const } : {}) });
    if (process.env.CLEDGER_CONFORMANCE_REPORT_DIRECTORY) {
      await mkdir(process.env.CLEDGER_CONFORMANCE_REPORT_DIRECTORY, { recursive: true });
      await writeFile(join(process.env.CLEDGER_CONFORMANCE_REPORT_DIRECTORY, cli + ".json"), JSON.stringify(report, null, 2) + "\n");
    }
    for (const name of ["multilineUnicode", "textRead", "toolError", "imageReference", "resume", "backfill", "noUnrecognized"]) assert.equal(report.cases[name]?.status, "pass", JSON.stringify(report));
    assert.equal(report.mode, "interactive");
    assert.equal(report.cases.userImageEntry?.status, "pass", JSON.stringify(report));
  });
}
