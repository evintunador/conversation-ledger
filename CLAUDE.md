# Working in conversation-ledger

## Writing secret-shaped fixtures (read before adding any test or doc example)

This project tests secret redaction, so its tests and docs constantly need
fake credentials — and this very conversation is being captured by cledger,
so every fake credential you type becomes ledger content that the pre-push
scan will flag and a human will have to review. Author fixtures so they never
enter that queue:

- **Any keyword-shaped fake** (`password=...`, `api_key: ...`, URL
  credentials, bearer tokens): put an uppercase marker inside the value —
  `FAKE`, `EXAMPLE`, `PLACEHOLDER`, `DUMMY`, `NOTREAL`, or `TESTONLY`.
  `password=FAKEhunter2aa` never becomes a finding; `password=hunter2aa1234`
  becomes one the moment you type it, in the file *and* in this transcript.
- **Format-valid tokens** (a real-looking `ghp_…`/`sk-ant-…` that must
  exercise a capture rule): never write one whole — not in a file, not in
  the chat, not in a commit message. Store it split as `secret_parts` in
  `src/test/fixtures/secret-corpus.json` and let the test reassemble it
  (see `src/test/secret-corpus.test.ts`). Markers do not exempt capture-tier
  formats, deliberately.
- Existing helpers already follow this; extend them rather than minting
  values inline (`fakeSecret(...)` in `src/test/redact.test.ts`, the corpus
  file for anything new).

If a scan finding does appear when pushing: **stop and tell the human.** Do
not run `cledger review`, `cledger inspect`, or `cledger export` to look at
it — reading flagged content into this conversation re-seeds the finding.
The human clears the queue with `cledger review` in a plain terminal.

## The standing tripwire

cledger records the work of building cledger. Before adding anything that
prints findings, reads cledger's own state, or writes examples about either,
ask: what happens when this output is itself captured? (See "Self-referential
failures" in the README roadmap.)
