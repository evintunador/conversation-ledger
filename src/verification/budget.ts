/** Durable conservative reservations; no refunds or usage-based estimates. */
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface ReviewedPrice {
  provider: string; model: string; revision: string; validUntil: string;
  /** Audited upper bound for ALL billed input, including provider/template overhead. */
  maxBillableInputTokens: number;
  maxOutputTokens: number;
  /** Reviewed tokenizer/template contract; mandatory, not an exact token estimate. */
  inputAccounting: {
    review: string; modelContextTokens: number;
    tokensPerUtf8ByteUpperBound: number;
    fixedOverheadTokens: number; perMessageOverheadTokens: number; perToolOverheadTokens: number;
  };
  /** Highest applicable uncached/cached/reasoning rates, micro-USD per million tokens. */
  inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number;
  endpoint: string;
}
interface Session {
  cli: string; provider: string; model: string; revision: string; phase: "initial" | "maintenance";
  campaign?: "issue27";
  expires: number; maxRequests: number; maxMicroUsd: number; requests: number; reservedMicroUsd: number;
}
interface State {
  schema: "cledger-budget/1";
  initial: Record<string, number>; months: Record<string, Record<string, number>>;
  sessions: Record<string, Session>;
  campaigns?: { issue27?: number };
}
const CEILING = 5_000_000;
const ISSUE27_CEILING = 20_000_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validScope(input: Omit<Session, "requests" | "reservedMicroUsd">): boolean {
  return typeof input.cli === "string" && /^[a-z][a-z0-9-]*$/.test(input.cli) &&
    [input.provider, input.model, input.revision].every(v => typeof v === "string" && !!v.trim()) &&
    ["initial", "maintenance"].includes(input.phase) && positive(input.expires) &&
    (input.campaign === undefined || input.campaign === "issue27") &&
    positive(input.maxRequests) && input.maxRequests <= 8 && positive(input.maxMicroUsd) && input.maxMicroUsd <= CEILING;
}
export function reservationCost(price: ReviewedPrice, now = Date.now()): number {
  if (!price.revision || !price.provider || !price.model || !Number.isFinite(Date.parse(price.validUntil)) || Date.parse(price.validUntil) <= now ||
      !positive(price.maxBillableInputTokens) || !positive(price.maxOutputTokens) ||
      !positive(price.inputMicroUsdPerMillion) || !positive(price.outputMicroUsdPerMillion)) throw Error("Reviewed pricing unavailable or expired");
  const accounting = price.inputAccounting;
  const nonnegative = (v: number) => Number.isSafeInteger(v) && v >= 0;
  if (!accounting?.review || !positive(accounting.modelContextTokens) || !positive(accounting.tokensPerUtf8ByteUpperBound) ||
      ![accounting.fixedOverheadTokens, accounting.perMessageOverheadTokens, accounting.perToolOverheadTokens].every(nonnegative) ||
      BigInt(price.maxBillableInputTokens) + BigInt(price.maxOutputTokens) > BigInt(accounting.modelContextTokens)) throw Error("Reviewed tokenizer/context accounting unavailable or inconsistent");
  const amount = Number((BigInt(price.maxBillableInputTokens) * BigInt(price.inputMicroUsdPerMillion) + 999999n) / 1000000n +
    (BigInt(price.maxOutputTokens) * BigInt(price.outputMicroUsdPerMillion) + 999999n) / 1000000n);
  if (!positive(amount)) throw Error("Invalid maximum reservation");
  return amount;
}
export class BudgetStore {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }
  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await open(this.path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ schema: "cledger-budget/1", initial: {}, months: {}, sessions: {} })); await file.sync(); }
    finally { await file.close(); }
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async change<T>(action: (state: State) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = this.path + ".lock";
    // Shared filesystem must provide atomic mkdir/rename and durable fsync.
    // A stale lock is deliberately NOT reclaimed automatically.
    await mkdir(lock, { mode: 0o700 });
    try {
      // A missing/deleted ledger NEVER silently restores a fresh allocation.
      const state = JSON.parse(await readFile(this.path, "utf8")) as State;
      const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
      if (state.schema !== "cledger-budget/1" || !record(state.initial) || !record(state.months) || !record(state.sessions) ||
          Object.values(state.months).some(v => !record(v))) throw Error("Invalid budget state");
      if (state.campaigns !== undefined && (!record(state.campaigns) || Object.entries(state.campaigns).some(([name, amount]) =>
        name !== "issue27" || !counter(amount) || amount > ISSUE27_CEILING))) throw Error("Invalid campaign budget state");
      // A missing counter must not restore funds after an authorized campaign
      // has already reserved costs. Older ledgers without campaign sessions
      // remain compatible with their original per-CLI contract.
      const campaignSessions = Object.values(state.sessions).filter(s => s.campaign === "issue27");
      const campaignReservations = campaignSessions.reduce((sum, s) => sum + s.reservedMicroUsd, 0);
      if (campaignSessions.length && (!counter(state.campaigns?.issue27) || state.campaigns!.issue27! < campaignReservations)) throw Error("Campaign reservations missing or inconsistent");
      const allocations = (v: Record<string, unknown>) => Object.entries(v).every(([cli, amount]) => /^[a-z][a-z0-9-]*$/.test(cli) && counter(amount) && amount <= CEILING);
      if (!allocations(state.initial) || Object.entries(state.months).some(([month, amounts]) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !allocations(amounts)) ||
          Object.entries(state.sessions).some(([token, session]) => !/^[a-f0-9]{64}$/.test(token) || !record(session) || !validScope(session as unknown as Session) ||
            !counter(session.requests) || !counter(session.reservedMicroUsd) || session.requests > session.maxRequests || session.reservedMicroUsd > session.maxMicroUsd)) throw Error("Corrupt budget allocation or scope");
      const result = action(state);
      const temporary = join(dirname(this.path), ".budget-" + randomUUID());
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally { await rm(lock, { recursive: true }); }
  }
  async createSession(input: Omit<Session, "requests" | "reservedMicroUsd">, now = Date.now()): Promise<string> {
    if (!validScope(input) ||
        input.expires <= now || input.expires > now + 900_000) throw Error("Invalid run authorization");
    const token = randomUUID() + randomUUID();
    await this.change(state => {
      if (input.campaign === "issue27") { state.campaigns ??= {}; state.campaigns.issue27 ??= 0; }
      state.sessions[hash(token)] = { ...input, requests: 0, reservedMicroUsd: 0 };
    });
    return token;
  }
  async reserve(token: string, price: ReviewedPrice, now = Date.now()): Promise<{ microUsd: number; cli: string }> {
    const cost = reservationCost(price, now);
    return this.change(state => {
      const session = state.sessions[hash(token)];
      if (!session || session.expires <= now || session.provider !== price.provider || session.model !== price.model || session.revision !== price.revision) throw Error("Run authorization missing, expired or mismatched");
      const month = new Date(now).toISOString().slice(0, 7);
      const monthly = state.months[month] ??= {};
      const initial = state.initial[session.cli] ?? 0, spent = monthly[session.cli] ?? 0;
      if (![initial, spent, session.requests, session.reservedMicroUsd].every(v => Number.isSafeInteger(v) && v >= 0)) throw Error("Corrupt budget counters");
      if (session.requests >= session.maxRequests || session.reservedMicroUsd + cost > session.maxMicroUsd || spent + cost > CEILING ||
          (session.phase === "initial" && initial + cost > CEILING)) throw Error("Budget exhausted; request not forwarded");
      if (session.campaign === "issue27") {
        const total = state.campaigns?.issue27;
        if (!counter(total) || total + cost > ISSUE27_CEILING) throw Error("Issue #27 campaign budget exhausted; request not forwarded");
        state.campaigns!.issue27 = total + cost;
      }
      session.requests++; session.reservedMicroUsd += cost; monthly[session.cli] = spent + cost;
      if (session.phase === "initial") state.initial[session.cli] = initial + cost;
      return { microUsd: cost, cli: session.cli };
    });
  }
}
