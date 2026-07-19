# Product intent

## Purpose

Conversation Ledger preserves durable, inspectable records of visible
conversations between people and coding agents. It is a general conversation
provenance primitive, not an intent-analysis product. Downstream consumers may
use its records as evidence about why a repository changed, but the ledger must
not impose that interpretation.

The record must remain useful to consumers beyond a single tool: cross-CLI
continuity, archival/export, code attribution, review, and later intent
retrieval are all valid independent uses.

## Behavioral commitments

- Preserve source material and provenance; do not silently rewrite history.
- Preserve exact visible turns before creating optional derived views.
- Retain enough provenance for consumers to determine applicability without
  treating any record as timeless truth.
- Record the repository, branch, commit, worktree state, author, timestamps,
  and capture mechanism with each artifact whenever available.
- Keep storage out of ordinary working-tree status views while retaining normal
  Git durability and shareability.
- Make sharing, retention, redaction, and deletion deliberate user choices.

## Non-goals for the foundation

- Deciding which historical statement is correct or intended.
- Summarizing, ranking, embedding, or otherwise interpreting conversations.
- Controlling an agent, enforcing a workflow, or orchestrating agents.
- Capturing reasoning the provider hides (visible reasoning is recorded when
  exposed), or claiming it can reproduce a native agent session.

Those belong to clients such as Turnbridge and Intent Recall, not to this core
storage layer.
