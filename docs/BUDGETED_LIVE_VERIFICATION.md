# Approved live verification and durable budgets

The manual `.github/workflows/live-verification.yml` adds a paid-capable tier;
no service, protected environment, credentials or paid run has been activated.
The free scheduled workflow still receives no paid credentials. This first
registered consumer drives the installed OpenCode TUI and checks automatic
prompt/tool/result/answer evidence before backfill. Other CLIs remain explicitly
unsupported by this automation; their existing manually observed live evidence
is separate. Adding a registry entry requires an actual isolated live consumer,
not merely a different binary name or documentation-shaped fixture.

## Approval and credential boundaries

A maintainer dispatches the workflow on the default branch, selecting the exact
CLI, reviewed provider/model, initial or maintenance phase, and run limit in
micro-USD (`1000000` = $1, maximum `5000000` = $5). Configure the GitHub
`live-verification` environment with required reviewers and prevent self-review
before using it. The reviewer checks those dispatch inputs and the authority's
current reviewed pricing; GitHub does not configure required reviewers merely
because the workflow names an environment.

The environment needs `CLEDGER_BUDGET_AUTHORITY` as an HTTPS origin variable and
`CLEDGER_BUDGET_ADMIN_TOKEN` as a secret. Provider credentials never go into
GitHub or the CLI. Only the authorization step receives the administration
credential; the pinned CLI is installed afterward. The consumer receives a
short-lived run credential scoped to CLI/provider/model/pricing revision and
maximum requests/reservation. A localhost relay presents that credential to the
external authority. It never exposes the provider key or administration token.
The scoped credential is deleted and never uploaded; evidence contains only the
pricing revision and model/provider selection. The first workflow supports
Linux only; ordinary free compatibility CI remains macOS/Linux.

The protected environment and HTTPS authority must exist before dispatch.
Absent configuration, unavailable/expired pricing, unsupported consumers,
provider errors or exhausted budgets stop the run without a paid fallback.
Approval alone does not prove capture or certify a CLI.

## Persistent authority

Run `dist/verification/budget-authority.js` on a trusted persistent machine,
behind an authenticated/rate-limited HTTPS reverse proxy. It binds only loopback.
Do not put its state on a disposable GitHub runner, use workflow artifacts as a
budget ledger, or create a fresh state path for each run. The service is not
installed or enabled by these files.

Provision a restricted persistent directory, then initialize its allocation
**once** with:

```sh
node dist/verification/budget-authority.js init /persistent/private/cledger-budget.json
```

Set `CLEDGER_BUDGET_STATE` to that path, `CLEDGER_BUDGET_CONFIG` to the reviewed
configuration file, and `CLEDGER_BUDGET_ADMIN_TOKEN` via a private secret manager.
Each route's `apiKeyEnv` names a provider credential supplied only to this trusted
service. Start it with `node dist/verification/budget-authority.js`; default
loopback port is 8787 (`CLEDGER_BUDGET_PORT` can change it). Do not copy keys into
configuration examples, terminal transcripts or evidence.

Configuration shape (illustrative, deliberately expired and without usable
prices or credentials):

```json
{
  "routes": [{
    "apiKeyEnv": "EXAMPLE_PROVIDER_KEY",
    "price": {
      "provider": "EXAMPLE-reviewed-provider",
      "model": "EXAMPLE-exact-model",
      "revision": "EXAMPLE-reviewed-price-and-protocol-version",
      "validUntil": "2000-01-01T00:00:00Z",
      "endpoint": "https://example.invalid/v1/chat/completions",
      "maxBillableInputTokens": 1,
      "maxOutputTokens": 1,
      "inputAccounting": {
        "review": "EXAMPLE-tokenizer-and-template-upper-bound-review",
        "modelContextTokens": 2,
        "tokensPerUtf8ByteUpperBound": 1,
        "fixedOverheadTokens": 1,
        "perMessageOverheadTokens": 1,
        "perToolOverheadTokens": 1
      },
      "inputMicroUsdPerMillion": 1,
      "outputMicroUsdPerMillion": 1
    }
  }]
}
```

An operator must review current official pricing, context limits and the exact
provider protocol before authorizing a real route. `maxBillableInputTokens` must
upper-bound **all billed input**, including server/template overhead; reserve
full model context, not a guessed token count from JSON. Output limits must bound
all billed output, including hidden reasoning where applicable. Use the highest
applicable cached/uncached/reasoning rates. `inputAccounting` is mandatory: a reviewed UTF-8-byte-to-token upper bound,
fixed hidden-input allowance, and per-message/per-tool framing allowances.
These must cover normalization, tool schemas/call framing, system/template
injection and all other billed preprocessing for the exact provider/tokenizer.
The authority computes a conservative bound on the exact forwarded JSON bytes
plus those allowances, then rejects requests exceeding the reservation input
ceiling or reviewed total context minus output. JSON byte count is **not an exact
token count**; it is usable only with that reviewed upper-bound contract. A
4096-token reservation cannot forward a 128K-context request merely because the
model accepts it. Bound arithmetic uses integers. The reviewed context must also
accommodate the entire reserved input and output ceilings. If the provider
cannot establish these bounds, has unbounded auxiliary charges, or ignores the
supported `max_tokens` limit, do not configure it. If tokenizer/preprocessing
bounds cannot be demonstrated from audited behavior, this proxy cannot promise
a hard cost cap; use a verified provider-side hard cap or keep the route disabled. Review data expires explicitly
and fails closed. A model or price change requires a new reviewed revision.

Only audited text Chat Completions/function tools are currently supported.
Attachments, hosted search/tools, unknown request fields, alternative transport
APIs and unsupported billable features are rejected. No runtime price lookup,
exchange-rate estimate or provider error message establishes a spending bound.
The endpoint is fixed in trusted configuration and requires HTTPS; callers
cannot choose an upstream URL or request redirects.

## Accounting contract and limitations

Before forwarding **each** request, reserve the full reviewed input ceiling plus
capped output at the highest rates, rounded up to integer micro-USD. Reservations
are never refunded, including errors, timeouts and absent usage. This can consume
more allocation than the provider eventually bills, but cannot rely on missing
usage to allow another request. Requests, output/body sizes, output tokens,
forwarding time and session lifetime are bounded. Authorization lasts fifteen
minutes, with four requests in the initial consumer; provisioning time counts.

State tracks each CLI's one-time initial $5 allocation and its UTC-calendar-month
$5 allocation across all run IDs, providers and models. Initial requests charge
**both** the initial allocation and current monthly allocation, conservatively;
maintenance charges the monthly allocation. Restarting the service, issuing a
new run ID or selecting a different model cannot replenish either allocation.
New calendar months replenish only the monthly allocation, not the initial one.

State changes take an exclusive filesystem directory lock, write a private
snapshot, fsync, atomically rename and fsync the directory **before forwarding**.
Concurrent processes either acquire that lock or fail closed. A crash-held lock
requires operator investigation before manual removal; there is no speculative
stale-lock recovery. Missing, malformed or deleted state fails closed rather than
silently rebuilding a fresh budget. Back up this state and keep one authoritative
path. A new host must move the durable state, not create a new allocation.
The filesystem must provide reliable atomic mkdir/rename and fsync semantics;
multiple independent copies, ephemeral disks and unreliable network mounts do
not enforce a shared budget. Trusted operators can reset files or change prices;
this is not protection against a compromised authority/operator/provider. If
these prerequisites cannot be met, keep paid automation disabled or use a
reviewed provider-side hard spending cap.

## Verification without paid calls

```sh
npm run build
node --test dist/test/verification-budget.test.js
```

Synthetic tests cover durable restart accounting, concurrency, retained charges
on provider failure, scoped authorization, unknown features/output caps, expired
pricing, stale locks, missing state, and oversized input refusal before reservation or forwarding. The HTTP test uses a mocked upstream and
requires loopback permission; a restricted sandbox reports an explicit skip.
These tests do not activate the authority, configure keys, dispatch paid CI or
claim that a production provider's pricing has been reviewed.

## Issue #27 campaign canaries

The `issue27` campaign has a shared **$20 total** ceiling across CLI IDs,
provider routes, initial/maintenance phases and months. Reservations are durable
worst-case charges and are never refunded from usage estimates. Existing
per-CLI ceilings also apply. A missing campaign counter with existing campaign
sessions fails closed instead of recreating an allocation.

The initial registered canary consumer is OpenCode in either native headless or
TUI mode. Set the existing explicit authority/provider/model/session variables
and use `budget-client authorize-canary`; this issues up to eight requests with
`campaign: issue27`. The client requires the authority to confirm that scope.
Run `budget-client run-canary SESSION OUTPUT OPENCODE_BINARY headless` (or
`interactive`). An ordinary legacy authorization cannot launch this canary.

The canary uses two fresh random text file values, normal exit and native
resume, automatic linked reads/results/answers, and two unchanged manual
backfills. Reports use `cledger-canary/1` with `inference: usual-provider` and
record the authority pricing revision. Provider/admin credentials stay outside
the native synthetic CLI profile.

No funded route, paid call or new protected CI environment has been activated.
Real provider pricing/account prerequisites remain pending. The free CI tests
use scripted substitutes and cannot satisfy real-model matrix cells.

### Candidate low-cost routes (checked 2026-10-05)

These are candidates for account setup, not activated authority routes or
proof that a pinned CLI accepts the model. Check account access and native
compatibility before registering a reviewed pricing revision. Rates below are
standard text input/output USD per million tokens; do not enable provider-side
search, hosted tools or other separately billed features for the file canary.

| Provider | Candidate | Input / output | Evidence and qualification |
| --- | --- | --- | --- |
| Google | `gemini-2.5-flash-lite` | $0.10 / $0.40 | [Official pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash-lite); native Gemini CLI compatibility still needs an installed canary. |
| OpenAI | `gpt-5-nano` | $0.05 / $0.40 | [Official model page](https://developers.openai.com/api/docs/models/gpt-5-nano); function calling supported, but the model is marked deprecated. Verify availability before selecting it. |
| OpenAI | `gpt-4.1-nano` | $0.10 / $0.40 | [Official model page](https://developers.openai.com/api/docs/models/gpt-4.1-nano); function calling supported, native CLI compatibility pending. |
| OpenAI | `gpt-5.4-nano` | $0.20 / $1.25 | [Official model page](https://developers.openai.com/api/docs/models/gpt-5.4-nano); a candidate if a pinned coding CLI rejects older nano models. |
| Anthropic | `claude-haiku-4-5` | $1.00 / $5.00 | [Official Haiku page](https://www.anthropic.com/claude/haiku); explicitly available in Claude Code. This is a supported candidate, not a claim that it is the cheapest currently available Anthropic model. |

A model's advertised function-calling support does not establish a native
CLI/tool dialect pass. Choose the cheapest available compatible model per CLI
and record the actual selected model in its canary evidence. Shared $20
reservations remain mandatory even for these low-cost routes. No model or
account call was made to prepare this shortlist.
