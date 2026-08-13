# Master Architecture Review

- **Review date:** 2026-08-12
- **Baseline:** `master` at `82575ff0f92447e8a87e2f9aede9408978d24663`
- **Scope:** Architecture, module boundaries, state ownership, persistence, lifecycle, and integration behavior
- **Excluded:** Security and threat-model review

## Executive summary

The codebase has strong local engineering discipline: TypeScript and Vue type checks pass, the test suite is large, lint is strict, and the dead-code ratchet has no regression. The main architectural risks are not local typing or formatting defects. They sit at boundaries where multiple modules believe they own the same transaction, lifecycle, or workflow.

This review found:

- **7 P1 findings** that can cause lost state, partial domain settlement, cross-save contamination, stale runtime effects, missing plot events, blocked turns, or orphaned combat sessions.
- **4 P2 findings** that make persistence workflows fragile, reverse the intended engine/UI dependency direction, split turn ownership across shallow modules, or leave upstream requests running after local cancellation.
- **No P0 finding** and no security assessment, by request.

The highest-leverage change is to turn `StateManager` from a shared patch utility into an explicit state-command boundary with two distinct contracts:

1. best-effort application for untrusted AI patch batches; and
2. atomic execution for code-owned domain operations such as craft settlement, combat settlement, plot transitions, snapshot restoration, and game creation.

The second priority is to make save identity and lifecycle ownership explicit. Every asynchronous load, refresh, combat wait, and runtime projection should be tied to a captured save generation and become invalid when that generation is closed.

## Review method

The review used the repository documentation and executable paths as the source of truth. Candidate problems were reported only after establishing:

- **Scope:** the component that owns the invariant;
- **Trigger:** a concrete runtime event;
- **Reach:** a production call path that reaches the code;
- **Impact:** the state or behavior that changes; and
- **Evidence:** source, tests, or documented contracts.

The architectural lens was module depth, ownership, dependency direction, lifecycle, and transaction seams. The aim was to find boundaries that force several callers to understand implementation details, rather than simply identifying large files.

## Current architecture at a glance

The primary gameplay path is:

```text
GamePage / Pinia stores
        |
        v
GamePipeline
        |
        v
AgentOrchestrator ----> request side chains ----> model clients
        |                         |
        |                         v
        +--------------------> StateManager ----> Dexie
                                      |
                                      v
                              effect runtime / EventBus
```

This shape is reasonable, but several arrows are not true ownership boundaries:

- `GamePipeline` and `AgentOrchestrator` both own parts of a turn.
- `StateManager` is the declared write boundary but does not provide one transaction model.
- Plot and new-game workflows write around `StateManager`.
- Runtime effect wiring is a second state projection without an aggregate lifecycle owner.
- Engine modules import UI-owned registry and type implementations.

## Severity definitions

- **P0:** Release-blocking, broadly catastrophic, or unrecoverable under ordinary use.
- **P1:** A reachable correctness or lifecycle defect that can corrupt state, lose a domain operation, block a primary workflow, or violate a load-bearing contract.
- **P2:** Significant architectural debt or resource-lifecycle defect that should be planned, but does not normally invalidate the main workflow immediately.

## Findings

### AR-01 — Parallel side-chain commits can lose character state

- **Priority:** P1
- **Owning boundary:** Per-save state mutation

`AgentOrchestrator` executes non-empty request side chains concurrently through `Promise.all` (`src/sillytavern/agent-orchestrator.ts:911-927`). Item and craft chains each build their own patches and independently call a provided `StateManager` (`src/sillytavern/item-gen-chain.ts:150-154`, `src/sillytavern/craft-gen-chain.ts:567-571`). `GamePipeline` creates separate manager instances for those callbacks (`src/ui/lib/game-pipeline.ts:2046-2078`, `src/ui/lib/game-pipeline.ts:2181-2223`).

Character item operations read an entire character, mutate its arrays, and persist the whole object with `characters.put` (`src/sillytavern/state-manager.ts:442-467`, `src/sillytavern/state-manager.ts:816-854`, `src/sillytavern/database.ts:1293-1295`). There is no per-save or per-character serialization across manager instances.

**Trigger:** A dispatcher result contains player-targeted item generation and craft/item updates whose commits overlap.

**Impact:** Both chains can read the same starting character. The later `put` silently overwrites the first chain's inventory or skill changes.

**Recommendation:** Add a per-save state executor that serializes all commands, or perform read/validate/mutate/write inside one repository transaction. Side chains may perform model work concurrently, but their state results should be combined and committed through one owner.

**Required regression test:** Start two deferred state commands against the same character, release their reads before either write, and prove both changes survive.

### AR-02 — Code-owned settlements use a best-effort patch interface

- **Priority:** P1
- **Owning boundary:** Domain transaction semantics

The `StateManager` header advertises all-success-or-rollback behavior (`src/sillytavern/state-manager.ts:7-12`), but `commitChatState` catches each patch failure, keeps applying later patches, and reports partial application (`src/sillytavern/state-manager.ts:230-298`). The public `StateCommitResult` explicitly exposes that partial result (`src/sillytavern/types.ts:1725-1732`).

That behavior is useful for an untrusted AI batch, where one malformed patch should not necessarily erase every valid patch. It is unsafe for a code-owned settlement that represents one domain operation.

Craft settlement builds a semantic batch of resource, material, reward, and product changes (`src/sillytavern/craft-resolver.ts:308-358`). Its tool handler logs commit errors but still returns the resolver's calculated success (`src/sillytavern/agent-tools.ts:768-805`). Combat similarly commits one settlement batch and ignores the result (`src/sillytavern/combat-v3/coordinator.ts:472-497`).

**Trigger:** A later material, resource, reward, or character patch fails after earlier settlement patches have persisted.

**Impact:** Crafting or combat can consume only part of its costs, omit rewards or state changes, and still proceed as though the action completed.

**Recommendation:** Split the interface by semantics:

- `commitBestEffortPatches` for untrusted AI output; and
- atomic domain commands such as `settleCraft` and `settleCombat`, which validate the whole operation before any write and commit it in one transaction.

**Required regression test:** Inject a failure into the last patch of craft and combat settlement and assert that no preceding state change persists.

### AR-03 — Save loading and refresh lack generation ownership

- **Priority:** P1
- **Owning boundary:** Active-save lifecycle

`GamePage` performs several asynchronous initialization steps before constructing its pipeline (`src/ui/components/game/GamePage.vue:73-102`). Unmount aborts only an existing pipeline, so it cannot cancel initialization while `pipeline` is still `null` (`src/ui/components/game/GamePage.vue:251-265`). The continuation repeatedly reads mutable global `ui.activeSaveId`, and can later create a pipeline or send an opening prompt after navigation (`src/ui/components/game/GamePage.vue:173-176`).

`game-store.loadSave` similarly has no last-load-wins token (`src/ui/stores/game-store.ts:872-915`). Its message restore reads the current mutable `activeSaveId`, not the load operation's captured ID (`src/ui/stores/game-store.ts:820-827`).

The final pipeline refresh has a related time-of-check/time-of-use race. `GamePipeline` checks `ownsActiveSave` before calling `refreshFromDb` (`src/ui/lib/game-pipeline.ts:425-431`), but `refreshFromDb` neither captures nor rechecks the save after asynchronous reads (`src/ui/stores/game-store.ts:921-955`).

**Trigger:** Open save A, navigate home while an initialization or final refresh await is pending, then open save B.

**Impact:** A stale continuation can overwrite B's in-memory characters, profile, plot data, messages, or opening-prompt flow.

**Recommendation:** Introduce an active-save generation token. Every load and refresh should accept an explicit `saveId` and generation, read only that ID, and check generation ownership immediately before every in-memory mutation. Closing a game page invalidates the generation even if no pipeline exists yet.

**Required regression tests:** Use deferred database promises to cover A-to-B navigation during both initial load and final refresh, and assert that only B mutates Pinia state.

### AR-04 — Effect wiring is not reconciled with persisted character state

- **Priority:** P1
- **Owning boundary:** Save-scoped runtime projections

Effect wiring is stored in a process-global per-save map and skips an owner key that is already registered (`src/sillytavern/effect-wiring.ts:57`, `src/sillytavern/effect-wiring.ts:132-165`). Full wiring is additive (`src/sillytavern/effect-wiring.ts:191-205`), while full teardown exists but has no production save-switch caller (`src/sillytavern/effect-wiring.ts:209-217`).

Several persisted mutations bypass that lifecycle:

- same-slot equipment replacement clears the old item's slot but wires only the new item (`src/sillytavern/state-manager.ts:1000-1017`);
- `remove_item` and `remove_skill` delete data without cleanup (`src/sillytavern/state-manager.ts:864-886`, `src/sillytavern/state-manager.ts:1153-1164`);
- `update_item` and `update_skill` can change scripts without re-registering them (`src/sillytavern/state-manager.ts:896-919`, `src/sillytavern/state-manager.ts:1130-1144`); and
- snapshot restore replaces character rows without rebuilding runtime subscriptions (`src/sillytavern/state-manager.ts:1475-1508`).

The first two removal paths are directly player-reachable from `ItemsPanel` (`src/ui/components/game/ItemsPanel.vue:199-226`).

**Trigger:** Replace, remove, or update a scripted item/skill, restore a snapshot with a different loadout, or switch away from a wired save.

**Impact:** Removed equipment can keep firing ghost effects, restored effects can remain absent, and changed scripts can retain stale callbacks.

**Recommendation:** Treat effect wiring as a derived projection owned by the save aggregate. After every relevant atomic character mutation, reconcile the desired owner/script set against the active wiring. Snapshot restore and save teardown should perform full close-and-rebuild operations.

**Required regression tests:** Cover same-slot replacement, equipped-item deletion, skill deletion, script update, snapshot restore, and save switch with observable subscription assertions rather than database-only assertions.

### AR-05 — Plot persistence bypasses the StateManager boundary

- **Priority:** P1
- **Owning boundary:** Plot state and domain-event publication

Pre-check activates plot events by writing directly through database helpers (`src/sillytavern/plot-engine.ts:135-153`). Post-check also saves updates directly (`src/sillytavern/plot-engine.ts:319-323`). This bypasses the existing `update_plot_event` operation, which creates a `plot_trigger` event (`src/sillytavern/state-manager.ts:1274-1286`). Only events produced through `commitChatState` are published to the effect system (`src/sillytavern/state-manager.ts:277-280`).

Post-check has a second ordering problem: it saves the initial update set, then propagates `worldLineChanged` to descendants afterward (`src/sillytavern/plot-engine.ts:343-347`, `src/sillytavern/plot-engine.ts:366-399`). The affected descendants are not saved again.

**Trigger:** Pre-check activates a plot event, post-check changes an event, or a moderate/major world-line change propagates to children.

**Impact:** Plot-trigger subscribers never receive the documented event, and descendant propagation flags disappear when the function returns.

**Recommendation:** Make plot evaluation pure with respect to persistence: return plot commands and all affected event changes. Commit the complete tree through the state boundary in one transaction and publish domain events once.

**Required regression test:** Execute a parent world-line change with descendants and assert both persisted descendant flags and one published `plot_trigger` event.

### AR-06 — Pipeline dependency semantics conflate completion with success

- **Priority:** P1
- **Owning boundary:** Agent DAG scheduling and failure policy

The default pipeline makes Story wait for `memory_recall` and `plot_pre_check` (`src/sillytavern/types.ts:447-450`). `stageDependenciesMet` considers a dependency satisfied only if its result exists without an error (`src/sillytavern/agent-orchestrator.ts:760-771`). An existing test asserts that Story is skipped when memory recall fails (`src/sillytavern/agent-orchestrator.test.ts:475-509`).

That behavior contradicts the product contract: Stage 0 agent failures should not block Stage 1, which depends on their completion rather than success (`docs/fated-poem-engine-prd.md:147-150`).

**Trigger:** Memory recall or plot pre-check exhausts retry handling and returns an error.

**Impact:** An optional preprocessing outage prevents the required Story agent from producing any narrative.

**Recommendation:** Give DAG edges scheduling semantics only: `waitFor` means settled. Put fatality in an explicit required/failure policy, using `requiredAgents` or per-stage policy. Optional failed agents should contribute an empty/fallback output.

**Required regression test:** Fail each optional Stage 0 agent independently and together, and assert that Story still runs with deterministic fallback context.

### AR-07 — Combat abandonment cannot terminate the production intent wait

- **Priority:** P1
- **Owning boundary:** Combat session cancellation

Production combat supplies a text-intent bridge (`src/ui/lib/game-pipeline.ts:1900-1906`, `src/ui/lib/game-pipeline.ts:1997-2003`). The coordinator prefers and awaits this bridge for player decisions (`src/sillytavern/combat-v3/coordinator.ts:670-696`, `src/sillytavern/combat-v3/coordinator.ts:741-764`).

The UI's `abandon` callback resolves only the older command resolver and never settles `pendingIntentResolve` (`src/ui/lib/game-pipeline.ts:1950-1963`). The repository changelog already records this unresolved behavior (`docs/CHANGELOG.md:229-232`).

**Trigger:** Skip or restart a combat while the coordinator awaits player intent.

**Impact:** The panel may close or a new combat may begin, but the old `runCombatV3` promise and session remain pending. A replacement handle can hide the orphan.

**Recommendation:** Replace the two resolver variables with one session-scoped cancellable input channel. Abandon should close the channel with an explicit cancellation result or `AbortSignal`, and every coordinator wait should terminate without settlement.

**Required regression test:** Abandon and restart from every player-input route and assert that the original run resolves, produces no settlement, and retains no active handle.

### AR-08 — Persistence workflows lack aggregate lifecycle ownership

- **Priority:** P2
- **Owning boundary:** Application-level persistence workflows

Backup import replaces Dexie data and reloads only API entries before reporting success (`src/ui/components/settings/DataSection.vue:316-328`). Worldbook, beautifier, workshop, and image-preset stores are initialized at application startup and their `init` methods are one-shot (`src/ui/App.vue:31-55`, `src/ui/stores/worldbook-store.ts:46-48`, `src/ui/stores/beautifier-store.ts:65-67`, `src/ui/stores/workshop-store.ts:158-160`, `src/ui/stores/image-preset-store.ts:81-89`).

New-game creation has the complementary write-side problem. `create-store` independently writes the character, save slot, optional profile, outline, and plot events (`src/ui/stores/create-store.ts:1807-1867`) with no encompassing transaction or rollback.

**Triggers:** Import a backup with different singleton data, or encounter an IndexedDB failure after one of the early new-game writes.

**Impact:** Imported data can remain invisible until reload and stale store edits can overwrite restored rows. New-game failure can leave orphan characters or visible but incompletely initialized saves.

**Recommendation:** Extract application services:

- `importBackup`, which owns database replacement, closes active saves, invalidates every singleton projection, and reloads them before success; and
- `createGame(command)`, which owns one transaction for every required row.

### AR-09 — Engine modules import UI-owned implementations

- **Priority:** P2
- **Owning boundary:** Content-provider dependency direction

The documented architecture says the engine is framework-independent (`docs/ARCHITECTURE.md:43`, `docs/fated-poem-engine-prd.md:214`). `content-source.ts` repeats the intended UI-to-engine direction (`src/sillytavern/content-source.ts:63-70`).

In production, engine modules import the Pinia-owned content registry directly (`src/sillytavern/agent-tools.ts:35`, `src/sillytavern/bloodlines.ts:21`, `src/sillytavern/location-db.ts:26`, `src/sillytavern/random-tables.ts:20`). The database imports a UI-owned `CreatePreset` type (`src/sillytavern/database.ts:41`), and the content source imports a UI hash helper (`src/sillytavern/content-source.ts:27`).

**Impact:** Headless engine loading pulls in UI ownership and tests need UI modules for engine behavior. Content changes cross both sides of the intended seam.

**Recommendation:** Move `ContentRegistry` interface/state, `CreatePreset`, and platform-neutral hash facilities into engine-owned modules. The Pinia content store should fetch/install content and inject immutable snapshots through that interface. Provide an in-memory adapter for engine tests.

### AR-10 — Turn orchestration ownership is split across shallow modules

- **Priority:** P2
- **Owning boundary:** Complete-turn workflow

`AgentOrchestrator` exposes stage events and a separate callback for each marker/workflow (`src/sillytavern/agent-orchestrator.ts:67-168`, `src/sillytavern/agent-orchestrator.ts:815-965`). `GamePipeline`, its production caller, wires those domain workflows back in through a large callback table (`src/ui/lib/game-pipeline.ts:1410-1514`). Both sides also construct concrete model and state adapters.

`GamePipelineDeps` accepts whole Pinia stores (`src/ui/lib/game-pipeline.ts:65-69`), but the implementation additionally reaches global audio, worldbook, and UI stores and constructs engine dependencies. Its declared interface is therefore both wider than necessary and incomplete.

**Impact:** Adding or changing a stage marker requires edits and test changes on both sides of the seam. Tests rely on module-level mocks and broad `as any` store doubles, so the interface provides little locality or leverage.

**Recommendation:** Choose one complete-turn owner, preferably the engine orchestrator. Inject narrow ports for model calls, state commands, content snapshots, and cancellation. Return typed UI effects for messages, audio, images, and combat instead of exporting every internal marker as a callback.

### AR-11 — Browser cancellation is not propagated through the BFF

- **Priority:** P2
- **Owning boundary:** End-to-end request lifecycle

The browser client supplies an `AbortSignal` for requests (`src/sillytavern/agent-client.ts:663-673`). The proxy's upstream `fetch` does not receive `c.req.raw.signal` (`server/routes/proxy.ts:96-102`).

**Trigger:** Stop, timeout, or navigation aborts a slow request before the provider returns response headers.

**Impact:** The browser considers the work cancelled while the BFF keeps the provider request and server connection alive. This consumes compute and cost and can outlive the save/page that initiated it.

**Recommendation:** Forward the inbound request signal to upstream `fetch`, while preserving the existing response-body cancellation behavior.

## Recommended target boundaries

### 1. Save command executor

One save-scoped executor should own ordering and transaction selection:

```text
model work / UI intent / domain resolver
                  |
                  v
          SaveCommandExecutor
          /                 \
best-effort AI patches   atomic domain command
          \                 /
                  v
          repository transaction
                  |
                  v
       persisted state + domain events
```

This boundary should also be responsible for publishing events only after successful persistence.

### 2. Save session lifecycle

A `SaveSession` should own:

- immutable `saveId` and generation identity;
- cancellation signal;
- pipeline and combat handles;
- state command executor;
- effect/event runtime; and
- close/reconcile behavior.

Pinia may project session state for Vue, but mutable global `activeSaveId` should not be the input to an asynchronous operation already in progress.

### 3. Complete-turn application service

The engine should expose one deep turn operation with narrow ports:

```ts
runTurn(input, {
  modelGateway,
  stateCommands,
  contentSnapshot,
  cancellation,
  uiEffects,
});
```

The exact interface should follow existing project conventions, but the module should hide stage ordering, marker routing, side-chain persistence, and result collation from the UI.

## Remediation roadmap

### Wave 1 — Correctness containment

1. Add per-save state serialization to stop lost concurrent updates.
2. Split best-effort AI patch commits from atomic domain commands.
3. Add save generation checks to load and refresh paths.
4. Replace combat resolver pairs with a cancellable input channel.
5. Correct Stage 0 dependency semantics to match the PRD.

### Wave 2 — Aggregate consistency

1. Reconcile effect wiring on every relevant mutation and rebuild it on restore/load.
2. Route plot transitions and propagation through the state command boundary.
3. Make new-game creation transactional.
4. Make backup import close, invalidate, and reload all projections.

### Wave 3 — Boundary deepening

1. Move the content registry and shared types to engine ownership.
2. Give the engine orchestrator ownership of a complete turn.
3. Replace whole-store dependencies with narrow ports.
4. Propagate cancellation through the BFF.

## Verification performed

The reviewed baseline passed:

```text
npm run typecheck       PASS
npm run typecheck:vue   PASS
npm run test:run        PASS — 319 files, 8,173 passed, 9 skipped
npm run lint            PASS
npm run knip:ratchet    PASS — no new dead-code findings
```

The suite emitted the existing JSDOM media/canvas capability warnings, but no gate failed.

These passing gates do not invalidate the findings. Most gaps require concurrency, deferred lifecycle, transaction-failure, or runtime-subscription tests that the current suite does not exercise.

## Review conclusion

The codebase does not need a broad rewrite. Its local modules and tests provide a solid base. The central improvement is to make declared architecture rules executable:

- a unique write entry must also own serialization and transaction semantics;
- save-scoped runtime state must be created, reconciled, and destroyed with the save session;
- dependency direction must be reflected in imports; and
- a workflow module should hide a complete workflow rather than exporting its internal stages to its caller.

Addressing the first two remediation waves will remove the reachable correctness failures. The third wave will reduce future shotgun surgery and make both engine and UI tests substantially narrower.
