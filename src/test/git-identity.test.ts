import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, git, gitUserIdentity, type RepoInfo } from "../git.js";
import { cleanupRepo, makeTempRepo } from "./helpers.js";

/**
 * The test machine (and CI) may have a real global user.email plus EMAIL /
 * GIT_AUTHOR_* in the environment; every test here must see none of that
 * except what it sets deliberately.
 */
const GIT_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "EMAIL",
];

function isolateGitEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of GIT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A repo with no user.email/user.name configured anywhere visible. */
async function makeIdentitylessRepo(): Promise<RepoInfo> {
  const dir = await mkdtemp(join(tmpdir(), "cledger-ident-"));
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  const repo = await findRepo(dir);
  if (!repo) throw new Error("failed to initialize temp repo");
  return repo;
}

test("gitUserIdentity: matches commit authorship — GIT_AUTHOR_EMAIL overrides user.email, as git would", async () => {
  const restore = isolateGitEnv();
  const repo = await makeTempRepo("cledger-ident-cfg-");
  try {
    process.env["GIT_AUTHOR_EMAIL"] = "env@example.com";
    process.env["GIT_AUTHOR_NAME"] = "Env User";
    const identity = await gitUserIdentity(repo);
    assert.strictEqual(identity.email, "env@example.com");
    assert.strictEqual(identity.name, "Env User");
  } finally {
    restore();
    await cleanupRepo(repo);
  }
});

test("gitUserIdentity: plain configured identity resolves as itself", async () => {
  const restore = isolateGitEnv();
  const repo = await makeTempRepo("cledger-ident-plain-");
  try {
    const identity = await gitUserIdentity(repo);
    assert.strictEqual(identity.email, "test@example.com");
    assert.strictEqual(identity.name, "Test User");
  } finally {
    restore();
    await cleanupRepo(repo);
  }
});

test("gitUserIdentity: user.email with no name anywhere still attributes via config fallback", async () => {
  const restore = isolateGitEnv();
  const repo = await makeIdentitylessRepo();
  try {
    await git(["config", "user.email", "only-email@example.com"], { cwd: repo.root });
    const identity = await gitUserIdentity(repo);
    assert.strictEqual(identity.email, "only-email@example.com");
    assert.strictEqual(identity.name, null);
  } finally {
    restore();
    await cleanupRepo(repo);
  }
});

test("gitUserIdentity: falls back to git's effective author identity from env", async () => {
  const restore = isolateGitEnv();
  const repo = await makeIdentitylessRepo();
  try {
    process.env["GIT_AUTHOR_EMAIL"] = "env@example.com";
    process.env["GIT_AUTHOR_NAME"] = "Env User";
    const identity = await gitUserIdentity(repo);
    assert.strictEqual(identity.email, "env@example.com");
    assert.strictEqual(identity.name, "Env User");
  } finally {
    restore();
    await cleanupRepo(repo);
  }
});

test("gitUserIdentity: never invents a hostname identity when git would have to guess", async () => {
  const restore = isolateGitEnv();
  const repo = await makeIdentitylessRepo();
  try {
    const identity = await gitUserIdentity(repo);
    assert.strictEqual(identity.email, null, "auto-detected user@host anchors churn and must not be used");
    assert.strictEqual(identity.name, null);
  } finally {
    restore();
    await cleanupRepo(repo);
  }
});
