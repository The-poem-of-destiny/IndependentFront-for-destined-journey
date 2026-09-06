# First-session reliability — 2026-09-05

Status: implemented; local gates and bounded browser checks passed. PR review pending.

Base: `c06442705c8a766dc5724804a0457a74e5109e77`.

## Authorized scope

The first recommended batch: ONB-01, DATA-01, LIFE-01 and LIFE-02. Open a PR,
then have a separate Astra agent review it. No merge is included in this request.

| Item    | Root cause                                                                                   | Implemented behavior                                                                                                                                                                                                                                                             | Status      |
| ------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| ONB-01  | Character creation ran before checking usable dialogue configuration.                        | Before the first character step, show content status and local API/model/Agent checks with direct settings links. Keep the existing default endpoint semantics, optional helpers and keyless local services.                                                                     | Implemented |
| DATA-01 | Each click started independent sequential writes across journey tables.                      | Coalesce concurrent submissions; persist character, save, profile, outline and events in one engine transaction; disable creation controls while writing and show retryable errors.                                                                                              | Implemented |
| LIFE-01 | Async loads committed into shared state without checking which request still owned the page. | Read complete save projections before publication; discard stale loads and refreshes using a generation; invalidate pending loads on page exit and stop disposed pages from constructing pipelines. Apply the same check to image and appearance projections loaded by the page. | Implemented |
| LIFE-02 | Stop unlocked input while background tasks and final cleanup still used shared run state.    | Keep input locked and reject overlapping runs until pending tasks and refresh finish. Disposed pipelines cannot project results into a later page session.                                                                                                                       | Implemented |

## Verification

- Before fixes, the focused regression command reproduced five failures: duplicate creation,
  partial save after a profile write failure, stale load overwriting the latest save,
  loading after page exit, and early input unlock after Stop.
- A separate component test reproduced the missing first-run readiness screen.
- Focused coverage also exercises creation failure/retry, settings precedence, missing model/address,
  keyless local services, optional helpers, stale refreshes, image/appearance load races and page exit
  before pipeline construction.
- `npm run gates`: all three type checks, build, formatting, lint, Knip ratchet and the full suite passed.
  2026-09-05 measured: 370 test files; 9,398 passed and 8 skipped.
- The first sandbox build failed to replace an existing `dist-ui` asset with Windows `EPERM`.
  The same gates command passed outside the sandbox; no build configuration workaround was added.
- Browser: isolated local origin `http://127.0.0.1:5188`, placeholder content, no configured endpoints.
  New Save showed the readiness screen before character steps; the blocked action explained the
  missing API and its link opened API settings. Screenshots inspected at the default viewport and
  480×800 confirmed readable content and reachable actions without clipping on the new screen.

## Bounds

- Readiness checks local configuration, not service availability or credit balance. Connection testing
  remains in API settings. No provider was contacted and no paid first turn was exercised.
- Placeholder content is explicitly labelled and remains usable; importing a private pack is not mandatory.
- Model recommendations, automatic Agent remapping, pricing estimates and a new onboarding wizard are outside this batch.
- The database/race tests use controlled failures and delayed promises; this is not a long gameplay soak test.
- Other registered issues, including atomic gameplay commands, effect reconciliation, full mobile layouts,
  server authorization and packaging, remain outside scope.

## Independent PR review

Pending after PR creation. Findings and any follow-up fixes will be recorded here.
