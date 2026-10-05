/** Execute installed cases; absent drivers stay visible rather than skipped passes. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET_CLIS } from "./roster.js";
import { PINNED_NPM_RUNTIMES, runtimeBinary } from "./runtimes.js";
import { CONFORMANCE_CASES, CONFORMANCE_DRIVERS, verifyCoreConformance } from "./conformance.js";
import type { ConformanceCli } from "./conformance-provider.js";

export async function runConformanceCampaign(options: { runtimeDirectory?: string; outputDirectory: string; selected?: string[]; modes?: ("headless" | "interactive")[] }) {
  const selected = options.selected ?? TARGET_CLIS.map(c => c.id);
  if (!selected.length || selected.some(id => !TARGET_CLIS.some(c => c.id === id))) throw Error("Select known nonempty CLI IDs");
  const modes = options.modes ?? ["headless", "interactive"];
  await mkdir(options.outputDirectory, { recursive: true });
  const results = [];
  for (const id of selected) for (const mode of modes) {
    if (!CONFORMANCE_DRIVERS.includes(id as ConformanceCli)) {
      const report = { schema: "cledger-conformance/1", cli: id, platform: `${process.platform}/${process.arch}`, mode, inference: "scripted", status: "not-run",
        reason: "Installed conformance driver pending; smoke/fixture coverage does not close this item", fullyCertified: false,
        cases: Object.fromEntries(CONFORMANCE_CASES.map(name => [name, { status: "not-run", detail: "Driver pending" }])) };
      results.push(report);
      await writeFile(join(options.outputDirectory, `${id}-${mode}.json`), JSON.stringify(report, null, 2) + "\n");
      continue;
    }
    const recipe = PINNED_NPM_RUNTIMES.find(r => r.cli === id);
    const binary = process.env[`CLEDGER_CONFORMANCE_${id.replaceAll("-", "_").toUpperCase()}_BINARY`] ??
      (options.runtimeDirectory && recipe ? runtimeBinary(options.runtimeDirectory, id, recipe.binary) : undefined);
    process.stderr.write(`Conformance ${id} ${mode}\n`);
    const report = await verifyCoreConformance(id as ConformanceCli, { mode, ...(binary ? { binary } : {}) });
    results.push(report);
    await writeFile(join(options.outputDirectory, `${id}-${mode}.json`), JSON.stringify(report, null, 2) + "\n");
    process.stderr.write(`${id} ${mode}: ${report.status}\n`);
  }
  return results;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--runtime-dir", "--output-dir", "--only", "--mode"].includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw Error("Usage: conformance-campaign.js --output-dir PATH [--runtime-dir PATH] [--only CLI_IDS] [--mode headless|interactive]");
    if (values[args[i]!]) throw Error("Duplicate argument");
    values[args[i]!] = args[i + 1]!;
  }
  if (!values["--output-dir"] || values["--mode"] && !["headless", "interactive"].includes(values["--mode"]!)) throw Error("Require --output-dir and a valid mode");
  const reports = await runConformanceCampaign({ outputDirectory: resolve(values["--output-dir"]!),
    ...(values["--runtime-dir"] ? { runtimeDirectory: values["--runtime-dir"] } : {}),
    ...(values["--only"] ? { selected: values["--only"].split(",") } : {}),
    ...(values["--mode"] ? { modes: [values["--mode"] as "headless" | "interactive"] } : {}),
  });
  process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  process.exitCode = reports.every(r => r.status === "pass") ? 0 : reports.some(r => r.status === "fail" || r.status === "partial") ? 1 : 2;
}
