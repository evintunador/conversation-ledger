/** Prepare code-only review changes in a hosted checkout; never push or merge here. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestRelease, runCampaign } from "./campaign.js";
import { pinProposal, prepareMaintenance, type PackageObservation } from "./maintenance.js";
import { provisionRuntimes } from "./runtimes.js";
import { TARGET_CLIS } from "./roster.js";

interface CandidateReport {
  targets: { id: string; verification: { status: string; reason?: string } }[];
}
export function candidatesQualified(baseline: string, changed: string[], headless?: CandidateReport, interactive?: CandidateReport): boolean {
  if (baseline !== "success" || !changed.length || !headless || !interactive || new Set(changed).size !== changed.length) return false;
  return changed.every(id => {
    const h = headless.targets.filter(t => t.id === id), i = interactive.targets.filter(t => t.id === id);
    return h.length === 1 && h[0]!.verification.status === "pass" && i.length === 1 &&
      i[0]!.verification.status === "pass";
  });
}

export function qualifiedChanges(baseline: string, changes: PackageObservation[], headless?: CandidateReport, interactive?: CandidateReport) {
  return changes.filter(change => candidatesQualified(baseline, [change.cli], headless, interactive));
}

/** Independent install/mode failures must leave later upstreams runnable. */
export async function checkCandidates(directory: string, changes: PackageObservation[], dependencies: {
  provision: (root: string, selected: string[], versions: Record<string, string>) => Promise<unknown>;
  run: (root: string, cli: string, mode: "headless" | "interactive") => Promise<CandidateReport>;
} = { provision: provisionRuntimes, run: (root, cli, mode) => runCampaign(false, root, [cli], true, mode) }) {
  const candidateErrors: { cli: string; reason: string }[] = [];
  const headless: CandidateReport = { targets: [] };
  const interactive: CandidateReport = { targets: [] };
  for (const change of changes) {
    // A broken install or driver for one upstream must not suppress other candidates.
    const root = join(directory, "candidate-runtimes", change.cli);
    try {
      await dependencies.provision(root, [change.cli], { [change.cli]: change.latest! });
      for (const [mode, report] of [["headless", headless], ["interactive", interactive]] as const) {
        try {
          const campaign = await dependencies.run(root, change.cli, mode);
          await writeFile(join(directory, `${change.cli}-${mode}.json`), JSON.stringify(campaign, null, 2) + "\n");
          report.targets.push(...campaign.targets.filter(target => target.id === change.cli));
        } catch (failure) {
          report.targets.push({ id: change.cli, verification: { status: "fail", reason: String(failure).slice(0, 4000) } });
        }
      }
    } catch (failure) {
      candidateErrors.push({ cli: change.cli, reason: String(failure).slice(0, 4000) });
    }
  }
  await writeFile(join(directory, "candidate-results.json"), JSON.stringify(headless, null, 2) + "\n");
  await writeFile(join(directory, "candidate-interactive.json"), JSON.stringify(interactive, null, 2) + "\n");
  return { headless, interactive, candidateErrors };
}

export async function prepareHostedReview(directory: string, baseline: string) {
  await mkdir(directory, { recursive: true });
  let maintenance: (Awaited<ReturnType<typeof prepareMaintenance>> & { campaign?: CandidateReport }) | undefined;
  let interactive: CandidateReport | undefined;
  const candidateErrors: { cli: string; reason: string }[] = [];
  let error: string | undefined;
  try {
    // A failed baseline is reported without proposing unqualified runtime upgrades.
    maintenance = await prepareMaintenance(directory, false);
    if (baseline === "success" && maintenance.changes.length) {
      const candidates = await checkCandidates(directory, maintenance.changes);
      maintenance = { ...maintenance, campaign: candidates.headless };
      interactive = candidates.interactive;
      candidateErrors.push(...candidates.candidateErrors);
    }
  } catch (failure) { error = String(failure).slice(0, 4000); }
  const releases: Record<string, Awaited<ReturnType<typeof latestRelease>>> = {};
  for (const cli of TARGET_CLIS) releases[cli.id] = await latestRelease(cli.repository);
  const proposedChanges = maintenance ? qualifiedChanges(baseline, maintenance.changes, maintenance.campaign, interactive) : [];
  const pinsProposed = proposedChanges.length > 0;
  if (pinsProposed) {
    const path = fileURLToPath(new URL("../../src/verification/runtimes.ts", import.meta.url));
    const source = pinProposal(await readFile(path, "utf8"), proposedChanges);
    await writeFile(path, source);
    await writeFile(join(directory, "runtimes.proposed.ts"), source);
  }
  const report = {
    schema: "cledger-hosted-maintenance/1", observedAt: new Date().toISOString(),
    baseline, pinsProposed, proposedChanges, candidateErrors, ...(error ? { error } : {}), maintenance, interactive, releases,
    inferenceCostUsd: 0, paidInferenceEnabled: false, autoMerge: false,
    candidatePlatform: process.platform, candidateArch: process.arch,
    qualification: "Candidate checks here run on one platform; the review branch must also pass full macOS/Linux qualification before merge",
    nonNpmUpdates: "Observed only; asset hashes, Python locks and adapters require source-specific review",
  };
  const evidenceDirectory = fileURLToPath(new URL("../../docs/verification-evidence/", import.meta.url));
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(directory, "review.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(evidenceDirectory, "maintenance-latest.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.REVIEW_DIRECTORY || !process.env.BASELINE_RESULT) throw Error("REVIEW_DIRECTORY and BASELINE_RESULT are required");
  const report = await prepareHostedReview(resolve(process.env.REVIEW_DIRECTORY), process.env.BASELINE_RESULT);
  console.log(JSON.stringify({ baseline: report.baseline, pinsProposed: report.pinsProposed, error: report.error }));
}
