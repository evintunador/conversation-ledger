/**
 * File payload policy for native captures. This never opens files or URLs.
 * Known embedded text is retained; binary bodies become evidence-bearing
 * references in BOTH normalized content and raw payloads. Opaque reasoning is
 * not a file attachment. Unrelated prose and arbitrary tool JSON are untouched.
 */
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { EventDraft } from "./schema.js";

const POLICY = "text-references/1";
const MAX_EMBEDDED_TEXT_BYTES = 1024 * 1024;
const TEXT_MEDIA = new Set([
  "application/json", "application/ld+json", "application/x-ndjson",
  "application/jsonl", "application/xml", "application/yaml", "application/x-yaml",
  "application/toml", "application/javascript", "application/typescript", "image/svg+xml",
]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".mdx", ".rst", ".csv", ".tsv", ".json", ".jsonl",
  ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs", ".go",
  ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".swift", ".rb", ".php",
  ".sh", ".bash", ".zsh", ".fish", ".sql", ".html", ".css", ".scss",
  ".vue", ".svelte", ".lua", ".r", ".ex", ".exs", ".erl", ".hs", ".pl",
  ".tex", ".svg", ".diff", ".patch", ".log",
]);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "license", "readme", ".gitignore", ".gitattributes", ".editorconfig"]);

/** Filename is only a candidate classifier; bytes must still decode as UTF-8. */
export function isKnownTextFilename(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase()) || TEXT_NAMES.has(basename(name).toLowerCase());
}

export function isTextMediaType(mediaType: string): boolean {
  const mime = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return mime.startsWith("text/") || TEXT_MEDIA.has(mime);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(path: string, key: string): string {
  return `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** A source occurrence is the reference even when no external locator exists. */
function embedded(value: string, mime: string, encoding: "base64" | "uri", path: string): unknown {
  let bytes: Buffer;
  try {
    if (encoding === "base64") {
      const compact = value.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
        throw new Error("invalid base64");
      }
      bytes = Buffer.from(compact, "base64");
    } else {
      bytes = Buffer.from(decodeURIComponent(value), "utf8");
    }
  } catch {
    return {
      type: "attachment_reference", media_type: mime,
      availability: "embedded_not_retained", reason: "invalid_encoding",
      encoded_sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  const facts = {
    media_type: mime,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  let reason = "binary";
  if (isTextMediaType(mime)) {
    reason = "text_size_limit";
    if (bytes.length <= MAX_EMBEDDED_TEXT_BYTES) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!text.includes("\0")) return { type: "attachment_text", ...facts, text };
        reason = "binary_content";
      } catch {
        reason = "invalid_utf8";
      }
    }
  }
  return { type: "attachment_reference", ...facts, availability: "embedded_not_retained", reason };
}

function dataUri(value: string, path: string): unknown | undefined {
  const match = /^data:([^,]*),(.*)$/s.exec(value);
  if (!match) return undefined;
  const header = match[1]!;
  const mime = header.split(";", 1)[0] || "text/plain";
  return embedded(match[2]!, mime, /;base64(?:;|$)/i.test(header) ? "base64" : "uri", path);
}

function walk(value: unknown, path: string, inheritedMime?: string, encodedCarrier = false): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const children = value.map((v, i) => walk(v, pointer(path, String(i))));
    return { value: children.map((v) => v.value), changed: children.some((v) => v.changed) };
  }
  if (!object(value)) return { value, changed: false };
  // Already processed payloads remain stable under repeated append/renormalize.
  if (value.type === "attachment_reference" || value.type === "attachment_text") {
    return { value, changed: false };
  }
  const out: Record<string, unknown> = {};
  let changed = false;
  // Observed Claude Code TUI @file attachment carrier: content.file has
  // MIME in type, explicit base64 bytes and native originalSize/dimensions.
  // A generic tool object's unrelated base64 prose is not this carrier.
  const nativeFile = typeof value.base64 === "string" && (typeof value.originalSize === "number" || path.endsWith("/file")) &&
    typeof value.type === "string" && /^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;.*)?$/i.test(value.type);
  const mime = [value.media_type, value.mediaType, value.mimeType, value.mime_type, value.mime, nativeFile ? value.type : undefined, inheritedMime]
    .find((v): v is string => typeof v === "string");
  const binaryData = value.type !== "text" && typeof value.data === "string" &&
    (encodedCarrier || value.type === "base64" || value.type === "image" || value.type === "audio" || value.type === "input_audio" ||
      (typeof value.assetId === "string" && typeof value.byteLength === "number"));
  for (const [key, child] of Object.entries(value)) {
    const field = pointer(path, key);
    // Ciphertext and signatures are replay state, not file bytes.
    if (key === "encrypted_content" || key === "thoughtSignature" || key === "signature") {
      out[key] = child;
      continue;
    }
    let replacement: unknown;
    if (key === "image_urls" && value.type === "image" && Array.isArray(child)) {
      const items = child.map((item, index) => typeof item === "string" ? dataUri(item, pointer(field, String(index))) ?? item : item);
      if (items.some((item, index) => item !== child[index])) replacement = items;
    }
    if (typeof child === "string" &&
      ["url", "uri", "image_url", "audio_url", "file_data", "image", "data"].includes(key)) {
      replacement = dataUri(child, field);
    }
    if (replacement === undefined && key === "base64" && nativeFile) {
      replacement = embedded(child as string, mime!, "base64", field);
    }
    if (replacement === undefined && key === "result" && value.type === "image_generation_call" && typeof child === "string") {
      // Responses image-generation output is base64 even when no MIME is supplied.
      // Do not infer an image format from the configured output preference.
      replacement = embedded(child, "application/octet-stream", "base64", field);
    } else if (replacement === undefined && key === "data" && binaryData) {
      replacement = embedded(child as string, mime ?? (value.type === "input_audio"
        ? `audio/${typeof value.format === "string" ? value.format : "unknown"}`
        : "application/octet-stream"), "base64", field);
    } else if (replacement === undefined && key === "file_data" && typeof child === "string" && value.type === "input_file") {
      const filename = typeof value.filename === "string" ? value.filename : "";
      replacement = embedded(child, mime ?? (isKnownTextFilename(filename) ? "text/plain" : "application/octet-stream"), "base64", field);
    } else if (key === "input_audio" && object(child) && typeof child.data === "string") {
      replacement = { ...child, data: embedded(child.data,
        `audio/${typeof child.format === "string" ? child.format : "unknown"}`, "base64", field) };
    }
    if (replacement !== undefined) {
      out[key] = replacement;
      changed = true;
    } else {
      const nested = walk(child, field, key === "source" ? mime : undefined, key === "inlineData" || key === "inline_data");
      out[key] = nested.value;
      changed ||= nested.changed;
    }
  }
  return { value: changed ? out : value, changed };
}

export function applyAttachmentPolicy(draft: EventDraft): EventDraft {
  // External producers own their vocabulary and retention policy.
  if (draft.producer.tool !== "cledger" || !draft.producer.source) return draft;
  const content = walk(draft.content, "/content");
  const raw = draft.raw ? walk(draft.raw.data, "/raw/data") : undefined;
  if (!content.changed && !raw?.changed) return draft;
  return {
    ...draft,
    content: content.value,
    ...(draft.raw ? { raw: {
      format: draft.raw.format.endsWith(`+${POLICY}`) ? draft.raw.format : `${draft.raw.format}+${POLICY}`,
      data: raw!.value,
    } } : {}),
  };
}
