import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadVerified, releaseAsset, runtimeEnvironment, validateArchiveListing } from "../verification/native-runtimes.js";

test("native downloads reject altered bytes before a runtime can be extracted or executed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cledger-download-test-"));
  try {
    const bytes = Buffer.from("TESTONLY-runtime-archive"), hash = createHash("sha256").update(bytes).digest("hex"), target = join(root, "archive");
    const request = (async () => new Response(bytes)) as typeof fetch;
    await assert.rejects(downloadVerified("https://example.invalid/release", target, "0".repeat(64), request), /SHA256 mismatch/);
    await assert.rejects(stat(target), { code: "ENOENT" });
    await downloadVerified("https://example.invalid/release", target, hash, request);
    assert.deepEqual(await readFile(target), bytes);
    await assert.rejects(downloadVerified("https://example.invalid/release", target, hash, request), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("portable native assets cover both supported architectures and retain OI package resources", () => {
  for (const platform of ["darwin", "linux"]) for (const arch of ["arm64", "x64"]) {
    for (const source of ["goose", "crush", "droid", "open-interpreter"]) {
      const asset = releaseAsset(source, platform, arch);
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.equal(new URL(asset.url).protocol, "https:");
      if (source === "open-interpreter") {
        assert.match(asset.url, /open-interpreter-package-/);
        assert.equal(asset.entrypoint, "bin/interpreter");
      }
    }
  }
  assert.throws(() => releaseAsset("crush", "win32", "x64"), /No pinned native runtime/);
  assert.throws(() => releaseAsset("unknown", "linux", "x64"), /No pinned native runtime/);
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"]]) {
    const asset = releaseAsset("cursor", platform!, arch!);
    assert.match(asset.url, /downloads\.cursor\.com\/lab\/2026\.10\.01-e373342\//);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.equal(asset.entrypoint, "dist-package/cursor-agent");
  }
});

test("archive paths and workflow environment output cannot escape intended destinations", () => {
  validateArchiveListing("./\n./goose\nbin/interpreter\ncodex-resources/bwrap\n");
  for (const listing of ["/tmp/escape", "safe/../../escape", "safe\\escape", ""]) assert.throws(() => validateArchiveListing(listing));
  assert.equal(runtimeEnvironment([{ cli: "open-interpreter", version: "0.0.45", path: "/tmp/runtime/bin/interpreter" }]), "CLEDGER_VERIFY_OPEN_INTERPRETER_BINARY=/tmp/runtime/bin/interpreter\n");
  assert.throws(() => runtimeEnvironment([{ cli: "aider", version: "0.86.2", path: "/tmp/path\nOTHER=value" }]), /line breaks/);
});
