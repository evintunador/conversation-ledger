import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureClineTranscript } from "../adapters/cline.js";
import { readEvents } from "../store.js";
import { makeTempRepo, makeCommit, cleanupRepo } from "./helpers.js";

test("Cline SDK artifacts preserve native types, child attribution, metadata and opaque reasoning", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const directory = join(repo.root, "fixture");
    await mkdir(directory);
    await writeFile(
      join(directory, "fixture.json"),
      JSON.stringify({
        version: 1,
        session_id: "fixture",
        cwd: repo.root,
        started_at: "2026-09-29T12:00:00Z",
        status: "completed",
        model: "do-not-infer",
      }),
    );
    const message = (
      id: string,
      role: string,
      content: unknown,
      metadata?: unknown,
    ) => ({ id, role, content, metadata, ts: 1_790_683_200_000 });
    const payload = {
      version: 1,
      sessionId: "fixture",
      origin: { mode: "user", source: "cli", version: "3.0.65" },
      system_prompt: "native system context",
      messages: [
        message("user", "user", [
          { type: "text", text: "prompt" },
          { type: "file", path: "/tmp/file.txt", content: "file text" },
          {
            type: "image",
            data: Buffer.from("TESTONLY image").toString("base64"),
            mediaType: "image/png",
          },
        ]),
        {
          ...message("assistant", "assistant", [
            { type: "text", text: "answer" },
            { type: "thinking", thinking: "visible reasoning" },
            { type: "redacted_thinking", data: "TESTONLY opaque" },
            {
              type: "tool_use",
              id: "call",
              name: "read_files",
              input: { files: [] },
            },
            {
              type: "media",
              media: {
                id: "media1",
                modality: "audio",
                mediaType: "audio/wav",
                source: {
                  type: "base64",
                  data: Buffer.from("TESTONLY audio").toString("base64"),
                },
              },
            },
          ]),
          modelInfo: { id: "actual-model", provider: "actual-provider" },
        },
        message("tool", "user", [
          {
            type: "tool_result",
            tool_use_id: "call",
            name: "read_files",
            content: "tool result",
          },
        ]),
        message("synthetic", "user", "summary", { kind: "compaction_summary" }),
        message("future", "assistant", [
          { type: "future-part", body: "preserve me" },
        ]),
        message("invalid", "assistant", null),
        12,
      ],
    };
    await writeFile(
      join(directory, "fixture.messages.json"),
      JSON.stringify(payload),
    );
    await writeFile(
      join(directory, "child.messages.json"),
      JSON.stringify({
        ...payload,
        sessionId: "child",
        origin: { mode: "user", parentThreadId: "fixture" },
        messages: [
          message("childuser", "user", "delegated"),
          message("childanswer", "assistant", "child answer"),
        ],
      }),
    );
    const result = await captureClineTranscript(directory, repo.root);
    assert.equal(result.unrecognized["content/future-part"], 1);
    assert.equal(result.unrecognized["message/invalid"], 1);
    assert.equal(result.unrecognized["message/non-object"], 1);
    const events = await readEvents(repo);
    const byId = (id: string) =>
      events.find(
        (e) =>
          (e.content as Record<string, unknown>).source_message_id === id &&
          e.kind !== "reasoning",
      )!;
    assert.equal(byId("user").actor.type, "human");
    assert.equal(byId("user").producer.model, undefined);
    assert.equal(byId("tool").actor.type, "system");
    assert.equal(byId("synthetic").kind, "context_injection");
    assert.equal(byId("assistant").producer.model, "actual-model");
    assert.equal(byId("childuser").actor.type, "system");
    assert.equal(byId("childanswer").actor.type, "agent");
    assert.equal(byId("childanswer").stream?.parent, "cline:fixture");
    assert.ok(!JSON.stringify(byId("assistant")).includes("TESTONLY opaque"));
    assert.ok(
      events.some(
        (e) =>
          e.kind === "reasoning" &&
          JSON.stringify(e).includes("TESTONLY opaque"),
      ),
    );
    assert.ok(!JSON.stringify(events).includes("TESTONLY image"));
    assert.ok(JSON.stringify(events).includes("attachment_reference"));
    assert.ok(JSON.stringify(events).includes("file text"));
    assert.equal(
      (await captureClineTranscript(directory, repo.root)).appended,
      0,
    );
    payload.messages.shift();
    await writeFile(
      join(directory, "fixture.messages.json"),
      JSON.stringify(payload),
    );
    assert.equal(
      (await captureClineTranscript(directory, repo.root)).appended,
      0,
      "message IDs survive preceding deletion",
    );
    assert.equal((await captureClineTranscript(directory, "/tmp")).appended, 0);
  } finally {
    await cleanupRepo(repo);
  }
});

import { readFile } from "node:fs/promises";
import { runClineTail } from "../adapters/cline-tail.js";

test("Cline final follower waits for settled terminal manifest and preserves compaction/corrupt snapshots", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const directory = join(repo.root, "fixture"),
      lock = join(repo.root, "tail.lock"),
      status = join(repo.root, "tail.json");
    await mkdir(directory);
    await mkdir(lock);
    const manifest = {
      version: 1,
      session_id: "fixture",
      cwd: repo.root,
      started_at: "2026-09-29T12:00:00Z",
      status: "running",
    };
    await writeFile(join(directory, "fixture.json"), JSON.stringify(manifest));
    await writeFile(
      join(directory, "fixture.compaction.json"),
      JSON.stringify({
        version: 1,
        source_message_count: 2,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "TESTONLY compact opaque" },
              { type: "thinking", thinking: "visible compact reasoning" },
            ],
          },
        ],
      }),
    );
    await writeFile(
      join(directory, "broken.messages.json"),
      "{malformed complete snapshot",
    );
    let failure: unknown;
    const timer = setTimeout(() => {
      writeFile(
        join(directory, "fixture.json"),
        JSON.stringify({
          ...manifest,
          status: "completed",
          ended_at: "2026-09-29T12:01:00Z",
        }),
      ).catch((error) => {
        failure = error;
      });
    }, 100);
    await runClineTail(directory, repo.root, lock, status);
    clearTimeout(timer);
    assert.equal(failure, undefined);
    assert.equal(JSON.parse(await readFile(status, "utf8")).status, "complete");
    const events = await readEvents(repo);
    assert.ok(
      events.some(
        (e) => (e.content as Record<string, unknown>).status === "completed",
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === "unrecognized" &&
          JSON.stringify(e.raw).includes("malformed complete snapshot"),
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === "reasoning" &&
          JSON.stringify(e.raw).includes("TESTONLY compact opaque"),
      ),
    );
    assert.ok(
      !events
        .filter((e) => e.kind !== "reasoning")
        .some((e) => JSON.stringify(e).includes("TESTONLY compact opaque")),
    );
    assert.equal(
      (await captureClineTranscript(directory, repo.root)).appended,
      0,
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("Cline interactive follower waits past the turn deadline for TUI exit", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const directory = join(repo.root, "fixture"),
      lock = join(repo.root, "tail.lock"),
      status = join(repo.root, "tail.json");
    await mkdir(directory);
    await mkdir(lock);
    const manifest = {
      version: 1,
      session_id: "fixture",
      cwd: repo.root,
      started_at: "2026-09-29T12:00:00Z",
      status: "running",
      interactive: true,
      pid: process.pid,
    };
    await writeFile(join(directory, "fixture.json"), JSON.stringify(manifest));
    const update = setTimeout(() => {
      writeFile(join(directory, "fixture.json"), JSON.stringify({
        ...manifest,
        status: "completed",
        ended_at: "2026-09-29T12:01:00Z",
      })).catch(() => {});
    }, 200);
    await runClineTail(directory, repo.root, lock, status, {
      initialDeadlineMs: 75,
      interactiveDeadlineMs: 1_000,
      settleMs: 30,
      pollMs: 20,
    });
    clearTimeout(update);
    assert.equal(JSON.parse(await readFile(status, "utf8")).status, "complete");
    assert.ok((await readEvents(repo)).some((event) =>
      (event.content as Record<string, unknown>).status === "completed"));
  } finally {
    await cleanupRepo(repo);
  }
});

import { renormalizeUnrecognizedMany } from "../adapters/cline.js";

test("Cline unknown parts retain replay envelope, parent/model provenance and processed attachments", async () => {
  const repo = await makeTempRepo();
  try {
    await makeCommit(repo, "base");
    const directory = join(repo.root, "fixture");
    await mkdir(directory);
    await writeFile(
      join(directory, "fixture.json"),
      JSON.stringify({
        version: 1,
        session_id: "fixture",
        cwd: repo.root,
        started_at: "2026-09-29T12:00:00Z",
      }),
    );
    await writeFile(
      join(directory, "child.messages.json"),
      JSON.stringify({
        version: 1,
        sessionId: "child",
        origin: { mode: "user", parentThreadId: "fixture", version: "3.0.65" },
        messages: [
          {
            id: "native-id",
            role: "assistant",
            modelInfo: { id: "native-model", provider: "native-provider" },
            content: [
              { type: "future", text: "future text" },
              { type: "image", data: "AAEC", mediaType: "image/png" },
              { type: "redacted_thinking", data: "TESTONLY opaque replay" },
            ],
          },
        ],
      }),
    );
    await captureClineTranscript(directory, repo.root);
    const unknown = (await readEvents(repo)).find(
      (e) => e.kind === "unrecognized",
    )!;
    assert.ok(unknown.raw!.format.includes("+text-references/1"));
    const raw = unknown.raw!.data as {
      artifact: string;
      message: { content: Record<string, unknown>[] };
    };
    assert.equal(raw.artifact, "message.part");
    assert.equal(
      renormalizeUnrecognizedMany(unknown, { name: null, email: null }),
      null,
    );
    // Simulate a future parser understanding the formerly unknown native part.
    raw.message.content[0]!.type = "text";
    const replay = renormalizeUnrecognizedMany(unknown, {
      name: null,
      email: null,
    });
    assert.ok(replay);
    assert.ok(replay.every((e) => e.kind !== "unrecognized"));
    assert.ok(replay.every((e) => e.stream?.parent === "cline:fixture"));
    assert.equal(replay[0]!.producer.model, "native-model");
    assert.equal(replay[0]!.producer.provider, "native-provider");
    assert.equal(
      (replay[0]!.content as Record<string, unknown>).source_message_id,
      "native-id",
    );
  } finally {
    await cleanupRepo(repo);
  }
});
