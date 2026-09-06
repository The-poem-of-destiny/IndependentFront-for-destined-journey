# Remaining reliability fixes — 2026-09-05

Status: implemented; all local gates passed; independent PR review pending.

Base: `c503fb6e392bc71d9ec4bca629ebf07f5851fde1`.

## Scope and root causes

| Finding   | Root cause                                                                         | Resolution                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EFFECT-01 | Owners were only added, never reconciled after removal or script changes.          | Reconcile saved character owners and script contents after commits/load; detach on exit/switch/delete.                                                                                                                              |
| STATE-01  | Domain callers used best-effort AI patches and ignored partial failure.            | `commitAiPatches` explicitly preserves best-effort behavior. `commitDomainCommand` rejects the complete action inside a save lock and Dexie transaction; no events on failure. Crafting, combat and item generation/rewrite use it. |
| A11Y-01   | Missing dialog focus ownership, notification announcements and keyboard selection. | Named dialogs, initial focus, nested focus ownership, Tab wrapping and focus return; live notifications; keyboard cards and separate native save/background buttons.                                                                |
| DEV-01    | Launchers killed listeners without proving process ownership.                      | Remove termination loops; existing `--strictPort` reports conflicts and exits.                                                                                                                                                      |

Transaction tests exposed an existing FP mismatch: domain builders use `delta_variable profile.fp`,
which the AI variable path stored as a story variable. The domain entry point now uses existing
`addFP`/`spendFP` accounting in the same transaction, including history and balance rejection.
No balance rules or dependencies changed.

## Verification

- Real IndexedDB tests cover missing materials, persistence rollback, and competing commands
  consuming one material. Production script-backend tests cover removed owners and changed scripts.
- Keyboard tests cover dialog naming, focus wrap/return, nested Escape, scroll locking, card
  activation and notification dismissal.
- Browser at `127.0.0.1:5188`: shared dialog was named correctly; Shift+Tab wrapped to the last
  control, Tab wrapped to Close, Escape dismissed and returned focus to the opener. Screenshot
  showed the existing layout and visible focus outline. No destructive confirmation was accepted.
- Windows launcher smoke: loopback sentinel listeners on 5173 and 5178 stayed alive while the
  launcher returned the occupied-port error. The initial wildcard-listener harness allowed Vite
  to bind separately on Windows; that test-owned Vite was identified and stopped before retrying
  successfully with the actual loopback address.
- Mechanical UI detector returned no findings. All local gates passed (373 test files; 9,413 passed, 8 skipped). The dead-code check initially found the no-longer-public cleanup helper; it was made private, then the ratchet and full suite passed. Independent review is pending.

## Bounds

This closes the named findings, not whole-app WCAG certification, mobile support, real macOS
execution, paid-provider gameplay, or production packaging. AI batches retain best-effort semantics.
Effect reactions remain bounded follow-up work after the primary command commits.

## Independent review

Pending PR creation. Review both standards and the four requirements above.
