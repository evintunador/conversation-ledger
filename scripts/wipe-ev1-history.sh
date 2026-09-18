#!/bin/sh
# Wipe pre-annals (ev1) cledger history: delete refs/notes/conversation-ledger
# locally and on origin for every repo that carries it, plus the incoming
# staging ref and any pending queue (both hold ev1-era events).
#
# Rationale: cledger 0.26.0 moved to the annals envelope (schema annals/v1,
# ids ev2-, `conversation` renamed `stream`). Old events are not migrated —
# the sole user chose a clean wipe over a rewrite. This script is DRY-RUN by
# default; pass --execute to actually delete. Run it yourself in a plain
# terminal — it deletes shared refs on origin, so it is deliberately not
# something an agent should execute for you.
#
# What it deliberately KEEPS:
#   - capture cursors (.git/conversation-ledger/cursors*) — so old transcripts
#     are not re-captured wholesale under new ids against today's HEAD
#   - allowlist.json / known-secrets.json — human judgments, still valid
#   - the installed pre-push hook — upgraded in place on the next append

set -eu

REPOS="
conversation-ledger
ds4-gateway
turnbridge
ds4_custom
intent-recall
context-graph
AI-s_non-anthropomorphic_path_to_understanding
tagseq2tagseq
arxiv-summaries-workflow
"
BASE="${BASE:-$HOME/repos/evintunador}"
REF=refs/notes/conversation-ledger
INCOMING=refs/notes/cledger-incoming
EXECUTE=false
[ "${1:-}" = "--execute" ] && EXECUTE=true

run() {
  if $EXECUTE; then echo "+ $*"; "$@" || echo "  (failed, continuing)"; else echo "DRY-RUN: $*"; fi
}

for name in $REPOS; do
  repo="$BASE/$name"
  [ -d "$repo/.git" ] || { echo "-- $name: not found, skipping"; continue; }
  echo "== $name"
  if git -C "$repo" rev-parse --verify --quiet "$REF" >/dev/null; then
    run git -C "$repo" update-ref -d "$REF"
  else
    echo "   no local $REF"
  fi
  git -C "$repo" rev-parse --verify --quiet "$INCOMING" >/dev/null &&
    run git -C "$repo" update-ref -d "$INCOMING" || true
  pending="$(git -C "$repo" rev-parse --git-common-dir)/conversation-ledger/pending.jsonl"
  [ -f "$pending" ] && run rm "$pending" || true
  if git -C "$repo" remote get-url origin >/dev/null 2>&1; then
    if git -C "$repo" ls-remote --exit-code origin "$REF" >/dev/null 2>&1; then
      # CLEDGER guard var predates 0.26.0 hooks; the new guard is
      # CONVERSATION_LEDGER_INTERNAL. Set both so no hook re-pushes mid-wipe.
      run env CLEDGER_INTERNAL=1 CONVERSATION_LEDGER_INTERNAL=1 \
        git -C "$repo" push origin ":$REF"
    else
      echo "   origin has no $REF"
    fi
  else
    echo "   no origin remote"
  fi
done
echo
$EXECUTE || echo "Nothing was changed. Re-run with --execute to delete."
