/** Minimal pinned Cursor Connect/protobuf fixture. It never forwards upstream.
 * Field numbers were inspected in installed 2026.10.01-e373342 descriptors.
 * The native executable performs reads, stores blobs and writes checkpoints.
 */
import { createServer } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type Fields = Map<number, Array<Buffer | bigint>>;
const MAX_MESSAGE = 2_000_000;
function integer(value: bigint): Buffer {
  if (value < 0n) throw Error("Negative protobuf integer");
  const bytes: number[] = [];
  do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
export function cursorField(field: number, value: Buffer | string | number): Buffer {
  if (!Number.isSafeInteger(field) || field < 1 || field > 536870911) throw Error("Invalid protobuf field");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid protobuf integer");
    return Buffer.concat([integer(BigInt(field) << 3n), integer(BigInt(value))]);
  }
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([integer((BigInt(field) << 3n) | 2n), integer(BigInt(bytes.length)), bytes]);
}
export function cursorFields(bytes: Buffer): Fields {
  if (bytes.length > MAX_MESSAGE) throw Error("Cursor protobuf message too large");
  const fields: Fields = new Map(); let offset = 0;
  const varint = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw Error("Truncated protobuf integer");
      const byte = bytes[offset++]!; result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return result;
    }
    throw Error("Oversized protobuf integer");
  };
  while (offset < bytes.length) {
    const tag = varint(), field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (field < 1 || field > 536870911) throw Error("Invalid protobuf tag");
    let value: Buffer | bigint;
    if (wire === 0) value = varint();
    else if ([1, 2, 5].includes(wire)) {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : 4;
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length); offset += length;
    } else throw Error("Unsupported protobuf wire type");
    const values = fields.get(field) ?? []; values.push(value); fields.set(field, values);
  }
  return fields;
}
const message = (fields: Fields, field: number) => {
  const value = fields.get(field)?.[0];
  return cursorFields(Buffer.isBuffer(value) ? value : Buffer.alloc(0));
};
const text = (fields: Fields, field: number) => {
  const value = fields.get(field)?.[0]; return Buffer.isBuffer(value) ? value.toString("utf8") : "";
};
const pack = (...fields: Buffer[]) => Buffer.concat(fields);
function frame(bytes: Buffer, flags = 0) {
  const header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(bytes.length, 1);
  return pack(header, bytes);
}

export async function startCursorProtocolFixture(repo: string): Promise<{
  state: { requests: number; reads: number; resumedPointers: number; session: string; prompts: string[]; toolError: boolean; textResult: string; imageResult: boolean; blocked: string };
  endpoint: string; agentEndpoint: string; signal: AbortSignal; close(): Promise<void>;
}> {
  const state = { requests: 0, reads: 0, resumedPointers: 0, session: "", prompts: [] as string[], toolError: false, textResult: "", imageResult: false, blocked: "" };
  const sockets = new Set<import("node:http2").ServerHttp2Session>();
  const controller = new AbortController();
  const api = createServer(async (req, res) => {
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_MESSAGE) { res.writeHead(413); res.end(); return; } }
    if (req.url === "/TESTONLY/update") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "2026.10.01-e373342", url: "http://127.0.0.1/TESTONLY/no-update" })); return;
    }
    if (req.url === "/auth/exchange_user_api_key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accessToken: "TESTONLY." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "TESTONLY" })).toString("base64url") + ".TESTONLY", refreshToken: "TESTONLY" })); return;
    }
    res.writeHead(200, { "content-type": "application/proto" });
    const model = cursorField(1, "fixture");
    if (/GetUsableModels|GetDefaultModelForCli/.test(req.url ?? "")) res.end(cursorField(1, model));
    else if (/AvailableModels/.test(req.url ?? "")) res.end(cursorField(2, pack(model, cursorField(5, 1), cursorField(10, 1))));
    else res.end();
  });
  const agent = createHttp2Server();
  agent.on("session", session => { sockets.add(session); session.on("close", () => sockets.delete(session)); session.on("error", () => {}); });
  agent.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    if (headers[":path"] !== "/agent.v1.AgentService/Run") { stream.respond({ ":status": 404 }); stream.end(); return; }
    if (++state.requests > 4) { state.blocked = "Cursor native run budget exceeded"; stream.respond({ ":status": 429 }); stream.end(); controller.abort(); return; }
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    let pending = Buffer.alloc(0), readIndex = 0, blobAcks = 0;
    const pointers: Buffer[] = [], prefix = randomUUID(); let prompt = "", answer = "";
    const send = (bytes: Buffer) => stream.write(frame(bytes));
    const interaction = (field: number, bytes: Buffer) => send(cursorField(1, cursorField(field, bytes)));
    const paths = [join(repo, "missing-TESTONLY.txt"), join(repo, "evidence.txt"), join(repo, "image-TESTONLY.png")];
    const callId = () => `TESTONLY-${prefix}-${readIndex}`;
    const toolCall = (result?: Buffer) => pack(cursorField(57, callId()), cursorField(8, pack(cursorField(1, cursorField(1, paths[readIndex]!)), ...(result ? [cursorField(2, result)] : []))));
    const read = () => {
      interaction(2, pack(cursorField(1, callId()), cursorField(2, toolCall())));
      send(cursorField(2, pack(cursorField(1, readIndex + 1), cursorField(15, callId()), cursorField(7, pack(cursorField(1, paths[readIndex]!), cursorField(2, callId()))))));
    };
    const checkpoint = () => {
      answer = "TESTONLY_CONFORMANCE_DONE " + state.textResult;
      for (const [index, value] of [{ role: "user", content: prompt }, { role: "assistant", content: answer }].entries()) {
        const key = Buffer.from(`TESTONLY-${prefix}-blob-${index}`); pointers.push(key);
        send(cursorField(4, pack(cursorField(1, index + 1), cursorField(3, pack(cursorField(1, key), cursorField(2, JSON.stringify(value)))))));
      }
      interaction(1, cursorField(1, answer));
    };
    const consume = (bytes: Buffer) => {
      const fields = cursorFields(bytes);
      if (fields.has(1)) {
        const run = message(fields, 1), user = message(message(message(run, 2), 1), 1);
        state.session = text(run, 5); prompt = text(user, 1); state.prompts.push(prompt);
        if (!state.session || !prompt.includes("TESTONLY_CONFORMANCE")) throw Error("Missing native Cursor session/prompt");
        for (const value of message(run, 1).get(1) ?? []) if (Buffer.isBuffer(value)) pointers.push(value);
        state.resumedPointers = pointers.length;
        if (pointers.length) readIndex = 1;
        read();
      } else if (fields.has(2)) {
        const exec = message(fields, 2);
        if (!exec.has(7)) return;
        state.reads++;
        const result = message(exec, 7), success = message(result, 1);
        let toolResult: Buffer;
        if (result.has(1)) {
          const bytes = success.get(5)?.[0];
          const body = text(success, 2);
          if (readIndex === 1) state.textResult = body;
          if (readIndex === 2) state.imageResult = Buffer.isBuffer(bytes) && bytes.length > 0;
          toolResult = cursorField(1, pack(cursorField(7, paths[readIndex]!), ...(Buffer.isBuffer(bytes) ? [cursorField(6, bytes)] : [cursorField(1, body)])));
        } else {
          if (readIndex === 0) state.toolError = true;
          toolResult = cursorField(2, cursorField(1, text(message(result, 2), 2) || "Native file read failed: " + paths[readIndex]!));
        }
        interaction(3, pack(cursorField(1, callId()), cursorField(2, toolCall(toolResult))));
        if (++readIndex < paths.length && pointers.length === 0) read(); else checkpoint();
      } else if (fields.has(3)) {
        const kv = message(fields, 3);
        if (kv.has(3) && ++blobAcks === 2) {
          send(cursorField(3, pack(...pointers.map(key => cursorField(1, key)))));
          interaction(14, Buffer.alloc(0));
          stream.end(frame(Buffer.from("{}"), 2));
        }
      }
    };
    stream.on("data", (chunk: Buffer) => {
      try {
        pending = pack(pending, chunk);
        if (pending.length > MAX_MESSAGE + 5) throw Error("Cursor Connect buffer too large");
        while (pending.length >= 5) {
          const length = pending.readUInt32BE(1);
          if (length > MAX_MESSAGE || pending[0] !== 0) throw Error("Unsupported Cursor Connect frame");
          if (pending.length < 5 + length) break;
          const bytes = pending.subarray(5, 5 + length); pending = pending.subarray(5 + length); consume(bytes);
        }
      } catch (error) { state.blocked = error instanceof Error ? error.message : String(error); controller.abort(); stream.close(); }
    });
  });
  const listen = async (server: typeof api | typeof agent) => {
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("Cursor fixture unavailable");
    return `http://127.0.0.1:${address.port}`;
  };
  const endpoint = await listen(api), agentEndpoint = await listen(agent);
  return { state, endpoint, agentEndpoint, signal: controller.signal, async close() {
    api.closeAllConnections(); for (const session of sockets) session.destroy();
    await Promise.all([new Promise<void>(done => api.close(() => done())), new Promise<void>(done => agent.close(() => done()))]);
  } };
}
