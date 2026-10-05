/** Build issue #27's matrix from recorded native evidence, never from fixtures. */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET_CLIS } from "./roster.js";
import { PINNED_NPM_RUNTIMES } from "./runtimes.js";
import { NATIVE_ASSETS } from "./native-assets.js";
import { CONFORMANCE_CASES } from "./conformance.js";

export const MATRIX_PLATFORMS = ["darwin", "linux"] as const;
export const MATRIX_MODES = ["headless", "interactive"] as const;
export const CANARY_GATES = ["prompt", "linkedReadResult", "answer", "normalExit", "resume", "backfillTwice", "automaticBeforeBackfill", "noUnrecognized"] as const;
type Status = "pass" | "fail" | "blocked" | "not-run" | "limitation";
interface Observation { status: Status; detail: string; evidence?: string; version?: string; reasonCode?: string }
interface Cell {
  smoke: Observation;
  scenario?: Observation;
  cases: Record<string, Observation>;
  local: Observation;
  usualProvider: Observation;
}
export interface MatrixRow { cli: string; name: string; pinnedVersion?: string; cells: Record<string, Cell> }
export interface EvidenceDocument { path: string; data: unknown }
const missing = (detail: string): Observation => ({ status: "not-run", detail });
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
function pin(cli: string): string | undefined {
  return PINNED_NPM_RUNTIMES.find(r => r.cli === cli)?.version ??
    (NATIVE_ASSETS as Record<string, { version: string }>)[cli]?.version ??
    ({ "mistral-vibe": "2.25.8", aider: "0.86.2", openhands: "1.16.0", cursor: "2026.10.01-e373342", kiro: "2.27.0" } as Record<string, string>)[cli];
}
function matchesVersion(version: unknown, expected: string | undefined): version is string {
  return typeof version === "string" && !!expected && (expected.includes("-") ? version.includes(expected) : version.match(/\d+\.\d+\.\d+/)?.[0] === expected);
}
const validStatus = (value: unknown): value is Status => ["pass", "fail", "blocked", "not-run", "limitation"].includes(String(value));

/** Later documents supersede earlier ones only for the exact CLI/version/mode/OS. */
export function buildSupportMatrix(documents: EvidenceDocument[]): { schema: "cledger-support-matrix/1"; issue: 27; complete: boolean; rows: MatrixRow[]; historicalEvidence: string[] } {
  const rows: MatrixRow[] = TARGET_CLIS.map(cli => ({ cli: cli.id, name: cli.name, ...(pin(cli.id) ? { pinnedVersion: pin(cli.id)! } : {}),
    cells: Object.fromEntries(MATRIX_PLATFORMS.flatMap(os => MATRIX_MODES.map(mode => [`${os}/${mode}`, {
      smoke: missing("No pinned installed smoke evidence"),
      cases: Object.fromEntries(CONFORMANCE_CASES.map(name => [name, missing("Installed conformance case pending")])),
      local: missing("Local DeepSeek canary pending"), usualProvider: missing("Usual-provider canary pending; API route or contributor account required"),
    }]))),
  }));
  const historicalEvidence: string[] = [];
  const stamp = (d: EvidenceDocument) => {
    const w = object(d.data), r = object(w?.report) ?? w;
    const date = r?.completed ?? r?.started ?? w?.observedOn ?? r?.date;
    return typeof date === "string" && Number.isFinite(Date.parse(date)) ? Date.parse(date) : 0;
  };
  for (const document of [...documents].sort((a, b) => stamp(a) - stamp(b) || a.path.localeCompare(b.path))) {
    const wrapper = object(document.data);
    if (!wrapper) continue;
    const data = wrapper.schema === "cledger-conformance-evidence/1" ? object(wrapper.report) : wrapper;
    if (!data) continue;
    if (data.schema === "cledger-campaign/1" && data.inference === "scripted" && Array.isArray(data.targets)) {
      for (const target of data.targets) {
        const report = object(target?.verification), row = rows.find(r => r.cli === target?.id);
        const cell = row?.cells[`${data.platform}/${data.mode}`];
        if (!report || !row || !cell || report.schema !== "cledger-verification/1" || report.inference !== "scripted" ||
            !matchesVersion(report.version, row.pinnedVersion) || !validStatus(report.status)) continue;
        cell.smoke = { status: report.status, detail: "Installed scripted smoke; does not prove the eight conformance cases", evidence: document.path, version: report.version };
      }
      continue;
    }
    const row = rows.find(r => r.cli === data.cli), os = String(data.platform).split("/")[0];
    const cell = row?.cells[`${os}/${data.mode}`];
    if (!row || !cell || !matchesVersion(data.version, row.pinnedVersion)) {
      if (["cledger-conformance/1", "cledger-live-verification/1", "cledger-canary/1"].includes(data.schema)) historicalEvidence.push(document.path);
      continue;
    }
    if (data.schema === "cledger-conformance/1" && data.inference === "scripted") {
      cell.scenario = { status: validStatus(data.status) ? data.status : data.status === "partial" ? "fail" : "not-run", detail: data.reason ?? `Installed scenario: ${data.status}`, evidence: document.path, version: data.version };
      if (!Number.isInteger(data.events) || data.events <= 0 || !Number.isInteger(data.requests) || data.requests <= 0) continue;
      for (const name of CONFORMANCE_CASES) {
        const result = object(data.cases?.[name]);
        if (!result || !validStatus(result.status) || typeof result.detail !== "string") continue;
        // A failed/incomplete native run cannot certify its case assertions.
        const status = result.status === "pass" && data.status === "blocked" ? "blocked" : result.status === "pass" && !["pass", "partial"].includes(data.status) ? "fail" : result.status;
        cell.cases[name] = { status, detail: status === "blocked" ? `Initial observation exists, but the installed scenario is incomplete: ${data.reason}` : result.detail, evidence: document.path, version: data.version };
      }
    } else if (data.schema === "cledger-canary/1" && ["local", "usual-provider"].includes(data.inference) && validStatus(data.status)) {
      const verified = CANARY_GATES.every(g => data.gates?.[g] === true);
      const result: Observation = { status: data.status === "pass" && !verified ? "fail" : data.status,
        detail: verified ? `${data.provider}/${data.model}: native canary gates passed` : data.reason ?? "Canary evidence incomplete", evidence: document.path, version: data.version, ...(typeof data.reasonCode === "string" ? { reasonCode: data.reasonCode } : {}) };
      if (data.inference === "local") cell.local = result; else cell.usualProvider = result;
    } else if (data.schema === "cledger-live-verification/1") historicalEvidence.push(document.path);
  }
  const resolved = (o: Observation) => o.status === "pass" || o.status === "limitation";
  const complete = rows.every(row => Object.values(row.cells).every(cell => Object.values(cell.cases).every(resolved) &&
    resolved(cell.local) && (resolved(cell.usualProvider) || cell.usualProvider.status === "blocked" && cell.usualProvider.reasonCode === "subscription-only")));
  return { schema: "cledger-support-matrix/1", issue: 27, complete, rows, historicalEvidence: [...new Set(historicalEvidence)] };
}
function label(o: Observation): string { return o.evidence ? `[${o.status}](${o.evidence})` : o.status; }
export function renderSupportMatrix(matrix: ReturnType<typeof buildSupportMatrix>): string {
  const lines = ["# Installed CLI and TUI support matrix", "", "Issue #27 covers eight selected cases at pinned versions, plus local DeepSeek and usual-provider canaries. A smoke pass does not certify those cases. This is not full record-type certification.", "",
    `Closing gate: **${matrix.complete ? "complete" : "open"}**. \`not-run\` means missing proof; \`blocked\` means a recorded prerequisite; \`limitation\` requires observed upstream evidence. Subscription-only usual-provider blockers may remain when closing the issue.`, ""];
  for (const os of MATRIX_PLATFORMS) {
    lines.push(`## ${os === "darwin" ? "macOS" : "Linux"}`, "", "| CLI (pin) | Headless cases | TUI cases | Headless local / usual | TUI local / usual |", "| --- | --- | --- | --- | --- |");
    for (const row of matrix.rows) {
      const h = row.cells[`${os}/headless`]!, t = row.cells[`${os}/interactive`]!;
      const summary = (cell: Cell) => `${Object.values(cell.cases).filter(c => c.status === "pass").length}/8 pass, ${Object.values(cell.cases).filter(c => c.status === "limitation").length} limitations${cell.scenario?.status === "fail" || cell.scenario?.status === "blocked" ? `; scenario ${label(cell.scenario)}` : ""}`;
      lines.push(`| ${row.name} (${row.pinnedVersion ?? "pin pending"}) | ${summary(h)} | ${summary(t)} | ${label(h.local)} / ${label(h.usualProvider)} | ${label(t.local)} / ${label(t.usualProvider)} |`);
    }
    for (const mode of MATRIX_MODES) {
      lines.push("", `### ${mode === "interactive" ? "TUI" : "Headless"} case evidence`, "", "| CLI | " + CONFORMANCE_CASES.join(" | ") + " |", "| --- | " + CONFORMANCE_CASES.map(() => "---").join(" | ") + " |");
      for (const row of matrix.rows) lines.push(`| ${row.name} | ${CONFORMANCE_CASES.map(name => label(row.cells[`${os}/${mode}`]!.cases[name]!)).join(" | ")} |`);
    }
  }
  lines.push("", "## Scope and reproduction", "", "Generate this file and its companion JSON with `npm run verify:matrix`. The JSON contains case details, exact versions, evidence paths, smoke observations, and historical evidence. Historical live reports lack parts of the agreed canary gate and remain historical rather than being promoted to passes.", "",
    "Run installed scenarios with `npm run verify:conformance -- --runtime-dir /tmp/cledger-runtimes --output-dir /tmp/cledger-conformance`. CI runs scripted cases on macOS and Linux. Local/provider canaries are separately gated; local inference is deferred until the machine is plugged in with cooling ready, and paid checks share a $20 campaign budget. No paid inference is enabled by generating this matrix.", "",
    "Additional attachment entry methods, document/archive inputs, invalid/oversized text, and fork/compaction/rewind/subagent lifecycle are separate follow-up issues. Normal exit/resume remains in this issue.", "");
  return lines.join("\n");
}
export async function matrixFromDirectory(directory: string) {
  const documents: EvidenceDocument[] = [];
  for (const name of (await readdir(directory)).filter(n => n.endsWith(".json")).sort()) {
    documents.push({ path: `verification-evidence/${name}`, data: JSON.parse(await readFile(join(directory, name), "utf8")) });
  }
  return buildSupportMatrix(documents);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 2) throw Error("Usage: support-matrix.js [EVIDENCE_DIRECTORY] [OUTPUT_MARKDOWN]");
  const matrix = await matrixFromDirectory(resolve(args[0] ?? "docs/verification-evidence"));
  const output = resolve(args[1] ?? "docs/SUPPORT_MATRIX.md");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderSupportMatrix(matrix));
  await writeFile(output.replace(/\.md$/, "") + ".json", JSON.stringify(matrix, null, 2) + "\n");
  process.stdout.write(`Wrote ${output}; issue #27 ${matrix.complete ? "complete" : "open"}\n`);
}
