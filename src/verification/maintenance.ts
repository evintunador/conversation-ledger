/** Observe public package versions and optionally verify candidates in isolation.
 * This prepares review artifacts; it never edits a checkout, pushes or merges.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_NPM_RUNTIMES, provisionRuntimes } from "./runtimes.js";
import { runCampaign } from "./campaign.js";

export interface PackageObservation {
  cli: string; package: string; pinned: string;
  status: "observed" | "unavailable"; latest?: string; reason?: string;
}
export async function observePackages(request: typeof fetch = fetch): Promise<PackageObservation[]> {
  const results: PackageObservation[] = [];
  for (const recipe of PINNED_NPM_RUNTIMES) {
    const base = { cli: recipe.cli, package: recipe.package, pinned: recipe.version };
    try {
      const response = await request(`https://registry.npmjs.org/${encodeURIComponent(recipe.package)}/latest`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
      const data = await response.json() as { version?: unknown };
      if (typeof data.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(data.version)) throw new Error("Registry returned no exact version");
      results.push({ ...base, status: "observed", latest: data.version });
    } catch (error) { results.push({ ...base, status: "unavailable", reason: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

/** A concrete source patch for review, only when every expected pinned line exists. */
export function pinProposal(source: string, observations: PackageObservation[]): string {
  let next = source;
  for (const record of observations) {
    if (record.status !== "observed" || !record.latest || record.latest === record.pinned) continue;
    const before = `cli: ${JSON.stringify(record.cli)}, package: ${JSON.stringify(record.package)}, version: ${JSON.stringify(record.pinned)}`;
    const after = `cli: ${JSON.stringify(record.cli)}, package: ${JSON.stringify(record.package)}, version: ${JSON.stringify(record.latest)}`;
    if (next.split(before).length !== 2) throw new Error(`Pin source changed for ${record.cli}; manual review required`);
    next = next.replace(before, after);
  }
  return next;
}

export async function prepareMaintenance(output: string, verifyCandidates = false) {
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  const observations = await observePackages();
  const changes = observations.filter(r => r.status === "observed" && r.latest !== r.pinned);
  const proposal = { schema: "cledger-maintenance/1", observedAt: new Date().toISOString(), reviewRequired: changes.length > 0 || observations.some(r => r.status === "unavailable"),
    observations, changes, paidInferenceEnabled: false, scope: "npm runtime pins; non-npm runtimes require their source-specific release review" };
  // Source may be absent in an npm-installed distribution. Keep version evidence
  // available even then; generating a source proposal is a checkout-only feature.
  try {
    const source = await readFile(fileURLToPath(new URL("../../src/verification/runtimes.ts", import.meta.url)), "utf8");
    await writeFile(join(directory, "runtimes.proposed.ts"), pinProposal(source, observations));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(join(directory, "proposal.json"), JSON.stringify(proposal, null, 2) + "\n", { mode: 0o600 });
  if (!verifyCandidates || !changes.length) return proposal;
  const candidateRoot = join(directory, "candidate-runtimes");
  await provisionRuntimes(candidateRoot, changes.map(c => c.cli), Object.fromEntries(changes.map(c => [c.cli, c.latest!])));
  const campaign = await runCampaign(false, candidateRoot, changes.map(c => c.cli), true);
  await writeFile(join(directory, "candidate-results.json"), JSON.stringify(campaign, null, 2) + "\n", { mode: 0o600 });
  return { ...proposal, campaign };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), directory = args.find(arg => !arg.startsWith("--"));
  if (!directory || args.some(arg => arg.startsWith("--") && arg !== "--verify-updates")) throw new Error("Usage: maintenance.js OUTPUT_DIR [--verify-updates]");
  const result = await prepareMaintenance(directory, args.includes("--verify-updates"));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.observations.some(r => r.status === "unavailable") || ("campaign" in result && result.campaign.targets.some(t => ["fail", "blocked"].includes(t.verification.status)))) process.exitCode = 1;
}
