/** Pinned public native/Python runtimes, installed only by an explicit operator. */
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_ASSETS } from "./native-assets.js";
import { isolatedEnvironment, runProcess } from "./process.js";

export const PYTHON_RUNTIMES = {
  aider: { version: "0.86.2", binary: "bin/python", packages: ["aider-chat"] },
  openhands: { version: "1.16.0", binary: "bin/openhands", packages: ["openhands", "openhands-sdk", "openhands-tools", "openhands-workspace"] },
} as const;
export const NATIVE_RUNTIME_IDS = [...Object.keys(PYTHON_RUNTIMES), ...Object.keys(NATIVE_ASSETS)];
interface Asset { url: string; sha256: string; archive: boolean; entrypoint: string }
interface InstalledRuntime { cli: string; version: string; path: string; sha256?: string; url?: string; dependencyLockSha256?: string }

export function releaseAsset(cli: string, platform: string, arch: string): Asset {
  const recipe = (NATIVE_ASSETS as Record<string, { version: string; variants: Record<string, Asset> }>)[cli];
  const asset = recipe?.variants[`${platform}/${arch}`];
  if (!asset) throw new Error(`No pinned native runtime for ${cli} on ${platform}/${arch}`);
  return asset;
}

export function runtimeEnvironment(results: InstalledRuntime[]): string {
  return results.map(({ cli, path }) => {
    if (/[\r\n]/.test(path)) throw new Error("Runtime paths must not contain line breaks");
    return `CLEDGER_VERIFY_${cli.toUpperCase().replaceAll("-", "_")}_BINARY=${path}\n`;
  }).join("");
}

/** Verify before extraction/execution. No metadata/API lookup can silently move a pin. */
export async function downloadVerified(url: string, destination: string, expected: string, request: typeof fetch = fetch): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected) || new URL(url).protocol !== "https:") throw new Error("Invalid pinned download");
  const response = await request(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed: HTTP ${response.status} (${url})`);
  const hash = createHash("sha256"), file = await open(destination, "wx");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024 * 1024) throw new Error("Runtime download exceeded 1 GiB");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (hash.digest("hex") !== expected) throw new Error(`SHA256 mismatch for ${url}`);
  } catch (error) {
    await file.close();
    await rm(destination, { force: true });
    throw error;
  }
  await file.close();
}

export function validateArchiveListing(listing: string): void {
  const paths = listing.split("\n").filter(Boolean);
  if (!paths.length) throw new Error("Empty runtime archive");
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\"))
      throw new Error(`Unsafe runtime archive member: ${path}`);
  }
}

export async function provisionNativeRuntimes(directory: string, selected?: string[]) {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Native runtime provisioning supports macOS/Linux arm64/x64");
  const requested = selected ?? NATIVE_RUNTIME_IDS;
  const unknown = requested.filter(id => !NATIVE_RUNTIME_IDS.includes(id));
  if (unknown.length) throw new Error(`Unknown native runtimes: ${unknown.join(", ")}`);
  if (new Set(requested).size !== requested.length) throw new Error("Duplicate native runtime selection");
  const root = resolve(directory), home = join(root, "native-installer-home");
  await mkdir(join(home, "tmp"), { recursive: true });
  const env = isolatedEnvironment(home, process.env.PATH ?? "/usr/bin:/bin");
  env.UV_CACHE_DIR = join(home, "uv-cache");
  env.UV_PYTHON_INSTALL_DIR = join(home, "python");
  env.UV_NO_CONFIG = "1";
  env.LITELLM_LOCAL_MODEL_COST_MAP = "True";
  env.DO_NOT_TRACK = "1";
  env.FACTORY_DROID_AUTO_UPDATE_ENABLED = "false";
  const run = async (command: string, args: string[], timeoutMs = 300_000) => {
    const result = await runProcess(command, args, { cwd: home, env, timeoutMs });
    if (result.code !== 0 || result.timedOut) throw new Error(`Runtime ${command} ${args[0]} failed: ${result.timedOut ? "deadline" : result.stderr.slice(-2000)}`);
    return result.stdout;
  };
  const results: InstalledRuntime[] = [];
  for (const cli of requested) {
    const prefix = join(root, cli);
    try { await lstat(prefix); throw new Error(`Refusing to overwrite runtime directory: ${prefix}; choose a fresh directory`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    process.stderr.write(`Provisioning isolated native ${cli}\n`);
    const python = (PYTHON_RUNTIMES as Record<string, { version: string; binary: string; packages: readonly string[] }>)[cli];
    let installed: InstalledRuntime;
    if (python) {
      const lock = fileURLToPath(new URL(`../../verification/requirements/${cli}.txt`, import.meta.url));
      const dependencyLockSha256 = createHash("sha256").update(await readFile(lock)).digest("hex");
      await run("uv", ["--no-config", "venv", "--python", "3.12", prefix]);
      await run("uv", ["--no-config", "pip", "sync", "--python", join(prefix, "bin", "python"), "--require-hashes", "--default-index", "https://pypi.org/simple", lock]);
      await copyFile(lock, join(prefix, "cledger-requirements.txt"));
      const freeze = await run("uv", ["--no-config", "pip", "freeze", "--python", join(prefix, "bin", "python")]);
      await writeFile(join(prefix, "cledger-installed.txt"), freeze);
      installed = { cli, version: python.version, path: join(prefix, python.binary), dependencyLockSha256 };
    } else {
      const asset = releaseAsset(cli, process.platform, process.arch);
      const version = (NATIVE_ASSETS as Record<string, { version: string }>)[cli]!.version;
      await mkdir(prefix, { recursive: true });
      const download = join(prefix, asset.archive ? "release.tar.gz" : asset.entrypoint);
      await downloadVerified(asset.url, download, asset.sha256);
      if (asset.archive) {
        validateArchiveListing(await run("tar", ["-tzf", download]));
        await run("tar", ["-xzf", download, "-C", prefix]);
      }
      installed = { cli, version, path: join(prefix, asset.entrypoint), url: asset.url, sha256: asset.sha256 };
      if (!(await lstat(installed.path)).isFile()) throw new Error(`Missing regular native entrypoint: ${installed.path}`);
      await chmod(installed.path, 0o755);
    }
    // Invoke only harmless version queries; no provider credentials or user HOME.
    const args = cli === "aider" ? ["-c", 'from importlib.metadata import version; print(version("aider-chat"))'] : ["--version"];
    const versionText = (await run(installed.path, args, 30_000)).trim();
    if (!versionText.includes(installed.version)) throw new Error(`Unexpected ${cli} runtime version: ${versionText}`);
    results.push(installed);
    await writeFile(join(root, "native-runtimes.json"), JSON.stringify({ schema: "cledger-native-runtimes/1", platform: `${process.platform}/${process.arch}`, installedAt: new Date().toISOString(), runtimes: results }, null, 2) + "\n");
    await writeFile(join(root, "native-runtimes.env"), runtimeEnvironment(results));
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...selected] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: native-runtimes.js DIRECTORY [aider goose droid openhands open-interpreter crush]");
  process.stdout.write(JSON.stringify(await provisionNativeRuntimes(directory, selected.length ? selected : undefined), null, 2) + "\n");
}
