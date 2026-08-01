# SCRATCH: `cledger redact` does not remove the secret

Working notes for whoever picks this up. Not a design doc — a problem
statement, the measurements behind it, and the decision that has to be made
before any code is written.

Status 2026-07-31: **unfixed**. `cledger redact` reports success while the
redacted value remains recoverable with one git command.

---

## 1. What was measured

Scratch repo, `redact.knownSecrets` on, value chosen so capture-tier
redaction would not catch it (so it lands raw and needs manual redaction):

```
$ echo '{"kind":"conversation_turn", ... "text":"my value is zzTOPSECRETVALUEzz ok"}' \
    | cledger append
$ cledger redact ev1-7bdf2121... --pattern zzTOPSECRETVALUEzz --reason test
companion event: ev1-279a0e320001
history squashed: yes                      <-- claims success
```

Reads are clean:

```
$ cledger log --all --json | grep -c zzTOPSECRETVALUEzz
0
```

The value is still there:

```
$ for r in $(git reflog show refs/notes/conversation-ledger | awk '{print $1}'); do
    git show "$r" | grep -q zzTOPSECRETVALUEzz && echo "FOUND in $r"
  done
FOUND in 8bdb47b
FOUND in 5e3d4ad
```

It goes away only after:

```
$ git reflog expire --expire=now --all && git gc --prune=now
→ secret recoverable: 0
```

**So the local purge is "no reader surfaces it", not "it is gone".** The
default reflog expiry window is 90 days.

There is a second, already-documented case that is worse and unaffected by any
of the above: if the notes ref was **already pushed**, `redactEvent` skips the
squash entirely (it checks `ls-remote` first) and only warns. Nothing is
removed anywhere, locally or on the remote.

---

## 2. Why the current mechanism cannot deliver redaction

- A note's content lives in the **notes ref's own commit chain**, not on the
  commit it annotates.
- Every `git notes add -f` writes a new commit whose tree contains the new
  blob; the previous commit — and its blob — stays in the ancestry.
- `redactEvent` rewrites the event at the tip, then, if unpushed, rebuilds the
  ref as a parentless commit (`commit-tree` with no `-p`) so the old chain
  becomes unreachable **from the ref**.
- `update-ref` writes a reflog entry for every one of those discarded commits.
  Unreachable-from-ref is not unreachable-from-repo. That is the gap.

---

## 3. The load-bearing fact for any redesign

**The notes tip is cumulative. Reading history is not required to see every
event.** Verified:

```
3 appends → 3 commits on refs/notes/conversation-ledger
$ git notes --ref=conversation-ledger show HEAD | wc -l
3                       <-- all three events present in the tip tree alone
```

`appendEvents` does `[...existing, ...fresh].sort()` and rewrites the whole
note, so each anchor's note accumulates and the tip holds the complete event
set.

This matters because it dissolves what looks like a three-way conflict between
"reads must see everything", "history must never be destroyed", and "redacted
bytes must be unrecoverable". Those only conflict if reads need history — and
they do not.

**The only thing the notes ref's history contains that the tip does not is
superseded copies of rewritten note bodies — i.e. exactly the pre-redaction
secrets.** A history-walking read would therefore add no conversations and
would surface every redacted value. (Concretely it would also hit
`dedupById`, whose tie-break prefers the earliest `recorded_at` — it would
actively *prefer* the un-redacted copy. That tie-break was written for
duplicate-anchor collapse, not for this, and must be revisited regardless.)

If the goal is that no evidence is ever lost, the tip already satisfies it.
Discarding the notes ref's internal commit history loses **zero events**.

---

## 4. Decision required before implementing

Both options below end in the same security state; they differ only in whether
the notes ref keeps its own commit chain.

**Option A — keep the squash, finish the job.** After the existing
squash-to-parentless-commit: expire the ledger ref's reflog, then prune. Small
change to existing code. Loses the notes ref's internal commit history, which
carries no unique events (§3).

**Option B — rewrite the chain.** Rebuild every commit in the notes ref with a
tree that has the secret removed, preserving the chain shape (filter-branch
shaped, scoped to one ref). Keeps a commit-by-commit audit trail of the ledger
ref itself. Strictly more work, same outcome for the secret. Still needs the
reflog expiry and prune from Option A — rewriting leaves the originals behind
exactly the same way.

**Recommendation: A**, unless there is a stated reason to keep the notes ref's
own commit chain. B's only benefit is auditing the ledger's storage layer,
which is not evidence about the repo and is not what the project promises to
preserve.

**The blocking sub-question either way:** reclaiming the objects needs a
prune, and `git gc --prune=now` is repo-wide — it would also drop unreachable
objects the user may want (dropped stashes, abandoned commits). Choices:

1. scoped `git reflog expire --expire=now refs/notes/conversation-ledger`
   plus an accepted repo-wide prune;
2. scoped reflog expiry only, objects left prunable, honest output saying so,
   `--prune` opt-in;
3. refuse to claim any local purge at all and route everything through
   credential rotation.

---

## 5. Must be fixed regardless of which option

- **Stop printing `history squashed: yes`.** Today it asserts an outcome the
  tool does not achieve. Until the reflog and objects are handled it should
  say what actually happened and what remains recoverable.
- **`dedupById`'s earliest-`recorded_at` tie-break** (`src/store.ts`) must
  never be able to prefer a pre-redaction copy of an event over its redacted
  successor. Currently reachable only if reads ever see both; do not leave it
  as a latent trap.
- **The already-pushed path** currently degrades to a warning. Whatever is
  decided, the output must be unambiguous that the value is shared and
  rotation is the only remedy — see the post-push purge roadmap entry, whose
  three hard parts (union-merge re-introduction, host retention of unreachable
  objects, preserving the `redaction` event itself) all still stand.

---

## 6. Files

- `src/store.ts` — `redactEvent` (squash logic, `ls-remote` check,
  `commit-tree`), `dedupById`, `appendEvents` (cumulative note write).
- `src/redact/known-secrets.ts` — opt-in store; already prevents *re-capture*
  of a known value, which is orthogonal to removing the copy already stored.
- `README.md` — roadmap entries "`cledger redact`'s local purge leaves the
  value in the reflog" and "Post-push purge".
- `docs/WIP_TECHNICAL_DESIGN.md` — "Redaction layers", "Redaction metadata".
