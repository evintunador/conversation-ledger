/** Metadata-only release polling. Never installs CLIs or invokes a model. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observePackages } from "./maintenance.js";
import { TARGET_CLIS } from "./roster.js";
import { NATIVE_ASSETS } from "./native-assets.js";
import { PYTHON_RUNTIMES } from "./native-runtimes.js";
import { PINNED_NPM_RUNTIMES, PINNED_VIBE_RUNTIME } from "./runtimes.js";

export interface ReleaseUpdate {
  cli: string;
  source: "npm" | "pypi" | "github-releases";
  package: string;
  pinned: string;
  latest: string;
  url: string;
}
import { STABLE, newerStableVersion } from "./release-version.js";
export { newerStableVersion } from "./release-version.js";
const pythonRecipes = () => [
  { cli: "aider", package: "aider-chat", pinned: PYTHON_RUNTIMES.aider.version },
  { cli: "openhands", package: "openhands", pinned: PYTHON_RUNTIMES.openhands.version },
  { cli: "mistral-vibe", package: PINNED_VIBE_RUNTIME.package, pinned: PINNED_VIBE_RUNTIME.version },
];
const nativeRecipes = () => (["goose", "crush", "open-interpreter"] as const).map(cli => ({
  cli, package: TARGET_CLIS.find(item => item.id === cli)!.repository!, pinned: NATIVE_ASSETS[cli].version,
}));
function sourceUrl(update: Omit<ReleaseUpdate, "url">): string {
  if (update.source === "npm") return `https://www.npmjs.com/package/${encodeURIComponent(update.package)}/v/${update.latest}`;
  if (update.source === "pypi") return `https://pypi.org/project/${update.package}/${update.latest}/`;
  const tag = `${update.cli === "open-interpreter" ? "rust-v" : "v"}${update.latest}`;
  return `https://github.com/${update.package}/releases/tag/${tag}`;
}
/** Both metadata and cross-job artifacts are untrusted until bound to our registry. */
export function validateUpdate(update: ReleaseUpdate): void {
  const recipes = [
    ...PINNED_NPM_RUNTIMES.map(item => ({ cli: item.cli, source: "npm", package: item.package, pinned: item.version })),
    ...pythonRecipes().map(item => ({ ...item, source: "pypi" })),
    ...nativeRecipes().map(item => ({ ...item, source: "github-releases" })),
  ];
  if (!update || typeof update.latest !== "string" || typeof update.pinned !== "string" ||
      !recipes.some(recipe => recipe.cli === update.cli && recipe.source === update.source && recipe.package === update.package && recipe.pinned === update.pinned) ||
      !newerStableVersion(update.latest, update.pinned) || update.url !== sourceUrl(update)) throw Error("Invalid release observation");
}
export const updateMarker = (update: ReleaseUpdate): string =>
  `<!-- cledger-cli-update:${update.cli}:${createHash("sha256").update(JSON.stringify([update.source, update.package, update.latest])).digest("hex")} -->`;
const qualificationMarker = (update: ReleaseUpdate) => updateMarker(update).replace("cledger-cli-update:", "cledger-cli-qualification:");

/** Closed issues also count: closing an update is an intentional disposition. */
export function unseenUpdates(updates: ReleaseUpdate[], bodies: string[]): ReleaseUpdate[] {
  return updates.filter(update => !bodies.some(body => body.includes(updateMarker(update))));
}
export function updateIssue(update: ReleaseUpdate, runUrl: string) {
  validateUpdate(update);
  return {
    title: `[CLI update] ${update.cli}: ${update.pinned} → ${update.latest}`,
    body: `${updateMarker(update)}\n\n` +
      `Upstream published a new version of **${update.cli}**. This is a release observation, not a confirmed compatibility failure.\n\n` +
      `\`\`\`json\n${JSON.stringify({ schema: "cledger-cli-update/1", ...update }, null, 2)}\n\`\`\`\n\n` +
      `[Upstream release](${update.url}) · [Detection run](${runUrl})\n\n` +
      `Verify this exact version in isolated runtimes on macOS and Linux, in headless and interactive modes. ` +
      `Keep the last passing pin if checks fail. Retain sanitized failure evidence and distinguish harness failures from adapter drift.\n\n` +
      (update.source === "npm" ? `The integration-maintenance workflow tests npm candidates and proposes qualified pins without inference. ` :
        `Update the source-specific pin, official asset hashes or Python locks as applicable, then run installed verification. `) +
      `If an adapter repair is needed, submit a draft PR with a regression test and link this issue. No automatic merge.\n\n` +
      `An external repair worker may consume this issue; CI does not invoke a model.`,
  };
}

export async function observeReleases(request: typeof fetch = fetch) {
  const updates: ReleaseUpdate[] = [];
  const unavailable: { cli: string; reason: string }[] = [];
  for (const item of await observePackages(request)) {
    if (item.status === "unavailable") unavailable.push({ cli: item.cli, reason: item.reason ?? "npm metadata unavailable" });
    else if (item.latest && !STABLE.test(item.latest)) unavailable.push({ cli: item.cli, reason: "npm latest is not a stable release" });
    else if (item.latest && newerStableVersion(item.latest, item.pinned)) {
      const update = { cli: item.cli, source: "npm" as const, package: item.package, pinned: item.pinned, latest: item.latest };
      updates.push({ ...update, url: sourceUrl(update) });
    }
  }
  const json = async (url: string) => {
    const response = await request(url, { signal: AbortSignal.timeout(15_000), redirect: "error",
      headers: { Accept: "application/json", "User-Agent": "conversation-ledger-release-watch" } });
    if (!response.ok) throw Error(`Metadata HTTP ${response.status}`);
    return await response.json();
  };
  for (const item of pythonRecipes()) {
    try {
      const data = await json(`https://pypi.org/pypi/${item.package}/json`) as { info?: { version?: unknown } };
      const latest = data.info?.version;
      if (typeof latest !== "string" || !STABLE.test(latest)) throw Error("No stable exact PyPI version");
      if (newerStableVersion(latest, item.pinned)) {
        const update = { ...item, latest, source: "pypi" as const };
        updates.push({ ...update, url: sourceUrl(update) });
      }
    } catch (error) { unavailable.push({ cli: item.cli, reason: String(error) }); }
  }
  for (const item of nativeRecipes()) {
    try {
      // Interpreter has multiple tracks; only the Rust CLI track matches our adapter.
      const releases = await json(`https://api.github.com/repos/${item.package}/releases?per_page=100`) as
        { tag_name?: unknown; draft?: boolean; prerelease?: boolean }[];
      if (!Array.isArray(releases)) throw Error("Invalid release list");
      const prefix = item.cli === "open-interpreter" ? "rust-v" : "v";
      const versions = releases.filter(release => !release.draft && !release.prerelease && typeof release.tag_name === "string" && release.tag_name.startsWith(prefix))
        .map(release => (release.tag_name as string).slice(prefix.length)).filter(version => STABLE.test(version));
      if (!versions.length) throw Error("No stable release on the supported track in the latest 100 releases");
      const latest = versions.reduce((a, b) => newerStableVersion(b, a) ? b : a);
      if (newerStableVersion(latest, item.pinned)) {
        const update = { ...item, latest, source: "github-releases" as const };
        updates.push({ ...update, url: sourceUrl(update) });
      }
    } catch (error) { unavailable.push({ cli: item.cli, reason: String(error) }); }
  }
  return { schema: "cledger-release-watch/1", updates, unavailable,
    unconfigured: [{ cli: "cursor", reason: "No verified public version metadata feed; pinned runtime remains covered by native verification" }] };
}

/** Runs in the issue-write job. Durable bot comments make dispatch failures retryable. */
export async function publishUpdateIssues(updates: ReleaseUpdate[], repository: string, token: string, runUrl: string,
  request: typeof fetch = fetch, qualificationRef?: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !new RegExp(`^https://github\\.com/${repository.replaceAll(".", "\\.")}/actions/runs/[0-9]+$`).test(runUrl)) throw Error("Invalid publish destination");
  // Validate the entire batch before any writes.
  const proposals = updates.map(update => ({ update, ...updateIssue(update, runUrl) }));
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      method, signal: AbortSignal.timeout(30_000), redirect: "error",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : await response.json();
  };
  const pages = async <T>(path: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const items = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`) as T[];
      if (!Array.isArray(items)) throw Error("Invalid GitHub list");
      all.push(...items);
      if (items.length < 100) return all;
    }
  };
  interface Issue { number: number; body: string | null; state: string; pull_request?: unknown; user: { login: string } }
  const issues = (await pages<Issue>("issues?state=all&creator=github-actions%5Bbot%5D"))
    .filter(issue => !issue.pull_request && issue.user?.login === "github-actions[bot]");
  const pending: { issue: Issue; update: ReleaseUpdate }[] = [];
  let created = 0;
  for (const proposal of proposals) {
    let issue = issues.find(item => item.body?.includes(updateMarker(proposal.update)));
    if (!issue) {
      issue = await api("issues", "POST", { title: proposal.title, body: proposal.body }) as Issue;
      if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw Error("Invalid created issue");
      issues.push(issue);
      created++;
    }
    if (qualificationRef && proposal.update.source === "npm" && issue.state === "open" && !pending.some(item => item.issue.number === issue!.number)) {
      const comments = await pages<{ body: string; user: { login: string } }>(`issues/${issue.number}/comments`);
      if (!comments.some(comment => comment.user?.login === "github-actions[bot]" && comment.body.includes(qualificationMarker(proposal.update))))
        pending.push({ issue, update: proposal.update });
    }
  }
  if (qualificationRef && pending.length) {
    await api("actions/workflows/integration-maintenance.yml/dispatches", "POST", { ref: qualificationRef });
    for (const { issue, update } of pending) await api(`issues/${issue.number}/comments`, "POST", {
      body: `${qualificationMarker(update)}\n\nScripted compatibility qualification dispatched by [this watcher run](${runUrl}). ` +
        `This records dispatch, not a passing result. See the integration-maintenance workflow and its review PR for results.`,
    });
  }
  return { created, skipped: updates.length - created, qualificationQueued: pending.length > 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--publish") {
    if (!process.env.GITHUB_REPOSITORY || !process.env.GH_TOKEN || !process.env.RELEASE_WATCH_RUN_URL || !process.env.RELEASE_WATCH_QUALIFY_REF || !process.argv[3]) throw Error("Missing publish configuration");
    const report = JSON.parse(await readFile(process.argv[3], "utf8")) as Awaited<ReturnType<typeof observeReleases>>;
    if (report.schema !== "cledger-release-watch/1" || !Array.isArray(report.updates)) throw Error("Invalid release report");
    console.log(JSON.stringify(await publishUpdateIssues(report.updates, process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN,
      process.env.RELEASE_WATCH_RUN_URL, fetch, process.env.RELEASE_WATCH_QUALIFY_REF)));
  } else {
    const output = process.argv[2];
    if (!output || process.argv.length !== 3) throw Error("Usage: release-watch.js OUTPUT_JSON | --publish INPUT_JSON");
    const report = await observeReleases();
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ updates: report.updates.length, unavailable: report.unavailable, unconfigured: report.unconfigured }));
    if (report.unavailable.length) process.exitCode = 1;
  }
}
