#!/usr/bin/env node
/** Persistent, opt-in authentication for issue #27's isolated Kiro profile. */
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [cli, social = "github", ...extra] = process.argv.slice(2);
if (cli === "--help" || cli === "-h") {
  console.log("Usage: node verification/login.mjs kiro [github|google|builder]");
  process.exit(0);
}
if (cli !== "kiro" || !["github", "google", "builder"].includes(social) || extra.length) {
  console.error("Usage: node verification/login.mjs kiro [github|google|builder]");
  console.error("Droid verification is contributor-blocked; this launcher does not start Droid.");
  process.exit(1);
}

const repository = fileURLToPath(new URL("../", import.meta.url));
const root = join(repository, "verification", ".private", "auth", "kiro");
const cwd = join(root, "repo");
const candidates = [
  ...(process.platform === "darwin" ? ["/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat"] : []),
  ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(directory =>
    ["kiro-cli-chat", "kiro-cli"].map(name => resolve(directory, name))),
];
let binary;
for (const candidate of candidates) {
  if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
    binary = candidate;
    break;
  }
}
if (!binary) {
  console.error("Kiro CLI is unavailable. Install it or put kiro-cli on PATH, then rerun this command.");
  process.exit(1);
}

for (const path of [root, cwd, ...["tmp", "config", "data", "cache", "state"].map(name => join(root, name))]) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
await writeFile(join(cwd, "README.txt"), "TESTONLY isolated authentication workspace. No real project or user transcript.\n", {
  flag: "wx", mode: 0o600,
}).catch(error => { if (error.code !== "EEXIST") throw error; });

const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  TMPDIR: join(root, "tmp"),
  TERM: process.env.TERM ?? "xterm-256color",
  LANG: process.env.LANG ?? "en_US.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const args = ["login", "--license", "free", ...(social === "builder" ? [] : ["--social", social])];
console.log(`Authentication profile: ${root}`);
console.log("Complete the browser login. This command does not submit a model prompt.");
const child = spawn(binary, args, { cwd, env, stdio: "inherit" });
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
