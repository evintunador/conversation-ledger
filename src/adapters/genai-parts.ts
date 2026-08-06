/**
 * Google GenAI `Part` conversion, shared by the gemini-cli and qwen-code
 * adapters.
 *
 * Both CLIs store conversation content as arrays of the `Part` union from
 * Google's GenAI SDK rather than the Anthropic-style block list claude-code
 * uses. Qwen Code is a fork of Gemini CLI, so this is one format with two
 * consumers, not a coincidence worth duplicating: the two adapters differ in
 * how they *find* and *order* content (an append-only per-line transcript vs.
 * a replayed write-ahead log), not in what a part means.
 *
 * The mapping targets the same block vocabulary the other adapters already
 * emit — `text` / `thinking` / `tool_use` / `tool_result` — so a downstream
 * consumer reading `content.blocks` does not need to know which coding CLI
 * produced a turn. That is a *renaming*, not an interpretation: every field
 * of the source part is carried across, and the untouched part is kept
 * verbatim in `raw.data` regardless.
 *
 * Parts this module does not recognize (`inlineData`, `fileData`,
 * `executableCode`, and whatever Google adds next) pass through verbatim
 * rather than being dropped or coerced. Unlike an unrecognized *line* type,
 * an unknown part shape is not format drift worth a warning — it is content
 * inside a turn the adapter otherwise understands completely, and preserving
 * it inside the turn keeps the turn whole.
 */

/** The subset of the GenAI `Part` union these CLIs actually persist. */
export interface GenAiPart {
  text?: string;
  /** Gemini marks reasoning by flagging an otherwise ordinary text part. */
  thought?: boolean;
  /** Opaque provider token authenticating a `thought` part; not content. */
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: unknown };
  [key: string]: unknown;
}

/**
 * `PartListUnion` in the SDK: content is a bare string, one part, or a list.
 * Gemini CLI stores all three shapes; Qwen Code always stores a list. Both go
 * through here so neither adapter has to care.
 */
export function ensurePartArray(content: unknown): GenAiPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) return content.filter(isPart);
  if (isPart(content)) return [content];
  return [];
}

function isPart(value: unknown): value is GenAiPart {
  return typeof value === "object" && value !== null;
}

/**
 * Convert one part to a ledger block.
 *
 * `thoughtSignature` is dropped for the same reason claude-code drops a
 * thinking block's `signature`: it is a provider-internal verification token
 * over the reasoning text, not part of what anyone said. It survives in
 * `raw.data` for a consumer replaying against the same provider.
 */
export function convertPart(part: GenAiPart): unknown {
  if (part.functionCall) {
    const call = part.functionCall;
    const block: Record<string, unknown> = { type: "tool_use" };
    if (typeof call.id === "string") block["id"] = call.id;
    if (typeof call.name === "string") block["name"] = call.name;
    if (call.args !== undefined) block["input"] = call.args;
    return block;
  }
  if (part.functionResponse) {
    const response = part.functionResponse;
    const block: Record<string, unknown> = { type: "tool_result" };
    if (typeof response.id === "string") block["tool_use_id"] = response.id;
    if (typeof response.name === "string") block["name"] = response.name;
    if (response.response !== undefined) block["content"] = response.response;
    return block;
  }
  if (typeof part.text === "string") {
    return part.thought === true
      ? { type: "thinking", text: part.text }
      : { type: "text", text: part.text };
  }
  // inlineData / fileData / executableCode / anything new: verbatim.
  const { thoughtSignature: _signature, ...rest } = part;
  return rest;
}

export function convertParts(content: unknown): unknown[] {
  return ensurePartArray(content).map(convertPart);
}

/**
 * True when a part list carries nothing a reader would see. Both CLIs record
 * structurally valid but empty turns (a step that produced only a tool call
 * writes an empty text part first), and an event whose only block is an empty
 * string adds a line to `cledger log` that says nothing.
 */
export function isEmptyParts(content: unknown): boolean {
  const parts = ensurePartArray(content);
  if (parts.length === 0) return true;
  return parts.every(
    (part) =>
      part.functionCall === undefined &&
      part.functionResponse === undefined &&
      (typeof part.text !== "string" ? Object.keys(part).length === 0 : part.text.trim() === ""),
  );
}
