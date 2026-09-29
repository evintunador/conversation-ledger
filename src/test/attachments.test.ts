import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAttachmentPolicy, isKnownTextFilename, isTextMediaType } from "../attachments.js";
import { eventId } from "../schema.js";
import { appendEvents } from "../store.js";
import { draft, makeTempRepo, makeCommit, cleanupRepo } from "./helpers.js";

const imageBytes = Buffer.from([137, 80, 78, 71, 0, 255, 17, 38]).toString("base64");
const imageUri = `data:image/png;base64,${imageBytes}`;
const variants = [
  { type: "image", image_urls: [imageUri, "https://example.invalid/external-image.png"] },
  { type: "image", mediaType: "image/png", data: imageBytes },
  { type: "media", media: { id: "native-media", modality: "image", mediaType: "image/png", source: { type: "base64", data: imageBytes } } },
  { type: "image", source: { type: "base64", media_type: "image/png", data: imageBytes } },
  { inlineData: { mimeType: "image/png", data: imageBytes } },
  { type: "image", mimeType: "image/png", data: imageBytes },
  { type: "image_url", image_url: { url: imageUri } },
  { type: "input_image", image_url: imageUri },
  { type: "audio_url", audio_url: `data:audio/wav;base64,${imageBytes}` },
  { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${imageBytes}` } },
  { type: "image_generation_call", id: "TESTONLY-image-output", result: imageBytes },
  { type: "file", mime: "image/png", filename: "chart.png", url: imageUri },
  { type: "input_file", filename: "chart.pdf", file_data: imageBytes },
  { type: "input_audio", input_audio: { format: "wav", data: imageBytes } },
  { type: "session.binary_asset", data: { assetId: "sha256:TESTONLY", byteLength: 8, data: imageBytes } },
];

test("attachment policy removes known embedded binary shapes from both content and raw", () => {
  for (const payload of variants) {
    const original = draft({ producer: { tool: "cledger", source: "test-cli" },
      content: { blocks: [payload] }, raw: { format: "test/1", data: payload } });
    const result = applyAttachmentPolicy(original);
    assert.ok(!JSON.stringify(result).includes(imageBytes), JSON.stringify(payload));
    assert.match(JSON.stringify(result.content), /attachment_reference/);
    assert.match(JSON.stringify(result.raw?.data), /embedded_not_retained/);
    assert.equal(result.raw?.format, "test/1+text-references/1");
    assert.deepEqual(applyAttachmentPolicy(result), result, "policy is idempotent");
    assert.ok(JSON.stringify(original).includes(imageBytes), "does not mutate input");
    assert.equal(eventId(original), eventId(result));
  }
});

test("text payloads decode losslessly, while invalid and oversized text becomes explicit references", () => {
  const text = "# A note\nUnicode: λ ☃\n";
  const capture = (mime: string, value: string) => applyAttachmentPolicy(draft({
    producer: { tool: "cledger", source: "test-cli" },
    content: { inlineData: { mimeType: mime, data: value } },
  })).content as { inlineData: { data: Record<string, unknown> } };
  const retained = capture("text/markdown", Buffer.from(text).toString("base64"));
  assert.equal(retained.inlineData.data.text, text);
  assert.equal(retained.inlineData.data.type, "attachment_text");
  assert.equal(capture("text/plain", Buffer.from([255]).toString("base64")).inlineData.data.reason, "invalid_utf8");
  assert.equal(capture("text/plain", "NOT VALID BASE64!").inlineData.data.reason, "invalid_encoding");
  assert.equal(capture("text/plain", Buffer.alloc(1024 * 1024 + 1, 65).toString("base64")).inlineData.data.reason, "text_size_limit");
  assert.ok(isTextMediaType("image/svg+xml"));
  assert.ok(!isTextMediaType("application/pdf"));
  assert.ok(!isTextMediaType("application/octet-stream"));
  assert.ok(isKnownTextFilename("src/test.ts"));
  assert.ok(isKnownTextFilename("Dockerfile"));
  assert.ok(!isKnownTextFilename("report.docx"));
  const file = applyAttachmentPolicy(draft({ producer: { tool: "cledger", source: "codex" },
    content: { type: "input_file", filename: "notes.md", file_data: Buffer.from(text).toString("base64") },
  })).content as { file_data: { text: string } };
  assert.equal(file.file_data.text, text);
});

test("text, source locators and opaque reasoning remain intact; external producers retain policy ownership", () => {
  const content = { blocks: [
    { type: "text", text: `literal example ${imageUri}` },
    { type: "file", filename: "a.png", url: "file:///workspace/a.png" },
    { type: "reasoning", encrypted_content: imageUri, signature: imageBytes },
  ] };
  const original = draft({ producer: { tool: "cledger", source: "codex" }, content });
  assert.deepEqual(applyAttachmentPolicy(original), original);
  const external = draft({ producer: { tool: "third-party", source: "cli" }, content: variants });
  assert.equal(applyAttachmentPolicy(external), external);
});

test("attachment references pass through real storage/redaction and repeated captures dedup", async () => {
  const repo = await makeTempRepo("cledger-attachments-");
  try {
    await makeCommit(repo, "attachments");
    const payload = { type: "file", filename: "plot.png", url: imageUri };
    const original = draft({ producer: { tool: "cledger", source: "test-cli" },
      stream: { id: "test-cli:attachments", seq: 1 },
      content: { blocks: [payload] }, raw: { format: "test/1", data: payload } });
    const first = await appendEvents(repo, [original]);
    assert.equal(first.appended.length, 1);
    const stored = first.appended[0]!;
    assert.ok(!JSON.stringify(stored).includes(imageBytes));
    assert.equal(stored.id, eventId(original));
    const second = await appendEvents(repo, [original, applyAttachmentPolicy(original)]);
    assert.equal(second.appended.length, 0);
    assert.equal(second.deduped, 2);
  } finally { await cleanupRepo(repo); }
});

test("explicit plaintext document sources are not decoded as base64", () => {
  const payload = { type: "document", source: { type: "text", media_type: "text/plain", data: "plain attachment", name: "note.txt" } };
  const original = draft({ producer: { tool: "cledger", source: "droid" }, content: payload, raw: { format: "droid/1", data: payload } });
  assert.deepEqual(applyAttachmentPolicy(original), original);
});


test("media source inherits its explicit enclosing media type for text retention", () => {
  const payload = { type: "media", media: { mediaType: "text/plain", source: { type: "base64", data: Buffer.from("TESTONLY-readable text").toString("base64") } } };
  const result = applyAttachmentPolicy(draft({ producer: { tool: "cledger", source: "cline" }, content: payload }));
  assert.match(JSON.stringify(result.content), /attachment_text/);
  assert.match(JSON.stringify(result.content), /TESTONLY-readable text/);
});


test("arbitrary tool JSON with MIME and data is not evidence of base64 encoding", () => {
  const payload = { type: "tool_result", content: { mime: "text/plain", data: "ordinary textual result" } };
  const original = draft({ producer: { tool: "cledger", source: "test-cli" }, content: payload, raw: { format: "test/1", data: payload } });
  assert.deepEqual(applyAttachmentPolicy(original), original);
});

test("generated image results retain digest evidence without guessing MIME or decoding ordinary results", () => {
  const payload = { type: "image_generation_call", result: imageBytes, output_format: "png" };
  for (const source of ["codex", "open-interpreter"]) {
    const result = applyAttachmentPolicy(draft({ producer: { tool: "cledger", source }, content: payload }));
    const content = result.content as { result: { media_type: string; size: number; sha256: string }; output_format: string };
    assert.equal(content.result.media_type, "application/octet-stream");
    assert.equal(content.result.size, 8);
    assert.match(content.result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(content.output_format, "png");
  }
  const ordinary = draft({ producer: { tool: "cledger", source: "codex" }, content: { type: "tool_result", result: imageBytes } });
  assert.deepEqual(applyAttachmentPolicy(ordinary), ordinary);
});
