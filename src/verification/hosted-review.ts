/** Prepare code-only review changes in a hosted checkout; never push or merge here. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestRelease, runCampaign } from "./campaign.js";
import { prepareMaintenance } from "./maintenance.js";
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

export async function prepareHostedReview(directory: string, baseline: string) {
  await mkdir(directory, { recursive: true });
  let maintenance: Awaited<ReturnType<typeof prepareMaintenance>> | undefined;
  let interactive: Awaited<ReturnType<typeof runCampaign>> | undefined;
  let error: string | undefined;
  try {
    // A failed baseline is reported without proposing unqualified runtime upgrades.
    maintenance = await prepareMaintenance(directory, baseline === "success");
    if (baseline === "success" && maintenance.changes.length && "campaign" in maintenance) {
      interactive = await runCampaign(false, join(directory, "candidate-runtimes"), maintenance.changes.map(c => c.cli), true, "interactive");
      await writeFile(join(directory, "candidate-interactive.json"), JSON.stringify(interactive, null, 2) + "\n");
    }
  } catch (failure) { error = String(failure).slice(0, 4000); }
  const releases: Record<string, Awaited<ReturnType<typeof latestRelease>>> = {};
  for (const cli of TARGET_CLIS) releases[cli.id] = await latestRelease(cli.repository);
  const pinsProposed = !!maintenance && candidatesQualified(baseline, maintenance.changes.map(c => c.cli),
    "campaign" in maintenance ? maintenance.campaign : undefined, interactive);
  if (pinsProposed) {
    const source = await readFile(join(directory, "runtimes.proposed.ts"), "utf8");
    await writeFile(fileURLToPath(new URL("../../src/verification/runtimes.ts", import.meta.url)), source);
  }
  const report = {
    schema: "cledger-hosted-maintenance/1", observedAt: new Date().toISOString(),
    baseline, pinsProposed, ...(error ? { error } : {}), maintenance, interactive, releases,
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
