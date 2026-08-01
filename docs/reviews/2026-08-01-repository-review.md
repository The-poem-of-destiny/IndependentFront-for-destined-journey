# Repository Review: IndependentFront for Destined Journey

**Repository:** `The-poem-of-destiny/IndependentFront-for-destined-journey`  
**Review date:** 2026-08-01  
**Baseline:** [`097b0e8a294d7ba8bd5c50cdf128fe06305713c5`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/commit/097b0e8a294d7ba8bd5c50cdf128fe06305713c5) on `master`  
**Review type:** Static repository, architecture, security, test, release, and maintainability review

## Executive summary

This is an ambitious and unusually disciplined development repository. It combines a sizeable deterministic TypeScript game engine, a Vue 3/Pinia user interface, Dexie/IndexedDB persistence, a multi-agent AI orchestration layer, a Hono-based local BFF, extensive design documentation, and a large Vitest suite. The code frequently records design intent, failure modes, and compatibility decisions directly beside the implementation. Recent work on deterministic combat, transactional persistence, migration safety, request cancellation, caching, and repository governance is strong.

The principal problem is **trust-boundary mismatch**. The product now consumes community workshop content, but two workshop mechanisms effectively execute that content with the application's browser privileges:

1. Workshop regex replacement strings are copied unchanged into the beautification pipeline and rendered with Vue `v-html`.
2. Workshop worldbook EJS is compiled with `new Function`; the implementation explicitly acknowledges that constructor-based escape to `globalThis` is possible.

These are not merely theoretical sandbox weaknesses. A normally installed workshop package can execute same-origin JavaScript, read API keys stored in `localStorage`, access saves in IndexedDB, invoke privileged local endpoints, and make network requests. The current installation UI says submissions are unreviewed, but it does not communicate that packages can execute code.

The local development server then amplifies the impact:

- The `/data` middleware has a confirmed absolute-path containment failure caused by Connect mount-prefix stripping.
- Write-capable JSON endpoints have no authentication, origin validation, schema validation, or body-size limits.
- The Hono BFF enables wildcard CORS and accepts an arbitrary target base URL while deliberately permitting loopback/private-network destinations.

There is also a release-path gap: `npm run build` creates `dist-ui`, but the APIs and `/data` middleware exist only in Vite's development hook. Root-level `data/` is not copied by Vite, no standalone production server exists, and CI does not run the build. The static build is therefore not a complete runnable product.

### Overall verdict

**Strong engineering foundation; not ready for untrusted workshop content or a public standalone release.**

Recommended release gates:

- Disable or redesign executable workshop content before public distribution.
- Patch the development-server file read and origin/authentication controls.
- Make the production artifact self-contained and exercise it in CI.
- Add real-browser security and end-to-end tests around workshop installation, streaming rendering, storage, and the BFF.

---

## Scope and methodology

The review covered:

- Repository metadata and recent commit history.
- Root configuration, scripts, TypeScript, Vite, Vitest, ESLint, and CI.
- Frontend startup, stores, rendering paths, and persistence.
- Hono BFF and Vite development middleware.
- Workshop network, installation, regex, and EJS paths.
- Architecture, governance, review, and planning documentation.
- Selected tests and current remediation history.

The baseline was rechecked immediately before producing this report. The latest commit remained `097b0e8a...`, dated 2026-08-01 04:55:36 UTC.

### Limitations

A complete local checkout could not be established in the review environment, so I did not independently run `npm ci`, the full test suite, `npm run build`, browser tests, or a dependency audit. Findings are based on current GitHub file contents, code search, commit history, and static reasoning. A harmless local JavaScript proof confirmed the documented `Object.constructor(...)` escape pattern used by the EJS runtime.

Commit messages report approximately 4,940 passing tests around the Phase 2 workshop merge, but that result was not independently reproduced here. The GitHub connector did not return current workflow-run status, so this report evaluates the workflow definition rather than asserting that the latest workflow run passed.

---

## Repository snapshot

| Area                   | Current state                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Primary stack          | TypeScript, Vue 3, Pinia, Vite, Hono, Dexie, Vitest                                 |
| Default branch         | `master`                                                                            |
| Latest reviewed commit | `097b0e8a294d7ba8bd5c50cdf128fe06305713c5`                                          |
| Repository size        | About 373.7 MiB according to GitHub repository metadata                             |
| Application state      | Browser-local settings plus IndexedDB/Dexie game data                               |
| AI integration         | OpenAI-compatible endpoints through a same-origin Hono forwarding layer             |
| Community content      | Remote workshop manifests, payloads, regex replacements, and EJS-enabled worldbooks |
| CI gates               | Install, TypeScript, Vue typecheck, Prettier check, ESLint, Vitest                  |
| Published releases     | GitHub showed no published release during review                                    |
| Declared license       | Package metadata says MIT; README separates code and narrative-content licensing    |
| Release server         | Planned in documentation, not implemented in current scripts/source                 |

---

## Architecture overview

The repository has four major execution surfaces:

```text
Vue / Pinia UI
    ├── TypeScript game and agent engine
    ├── Dexie / IndexedDB persistence
    ├── Vite development middleware + Hono BFF
    └── Remote creative workshop
            ├── worldbook entries, including EJS
            └── regex replacement rules rendered as HTML
```

The engine/UI separation is generally good. The deterministic game systems are concentrated under `src/sillytavern/`, while Vue components and stores live under `src/ui/`. The BFF consolidates model-provider network traffic, and the workshop client consolidates remote workshop traffic.

The architectural weakness is that community content crosses from a data plane into an execution plane without a real isolation boundary.

---

## What the repository does well

### 1. Strong modularity and deterministic-engine discipline

The repository consistently separates pure calculations, orchestration, persistence, and presentation. Recent combat-v3 work introduces deterministic dice tapes, replay fixtures, explicit action state, and anti-nondeterminism checks. This is a sound direction for a rules-heavy RPG engine.

### 2. Broad automated test culture

Tests are colocated throughout the engine, UI stores, components, workshop client, migrations, asset system, and combat modules. The current Vitest default is Node, while numerous component files opt into jsdom. The repository clearly treats tests as a delivery requirement rather than an afterthought.

### 3. Useful CI quality floor

The workflow runs clean installation, TypeScript checking, Vue SFC checking, formatting, linting, and tests on pushes and pull requests. That is a good baseline and significantly better than a test-only workflow.

### 4. Good internal governance

`AGENTS.md`, the repository-governance plan, `.editorconfig`, `.gitattributes`, and `CODEOWNERS` show deliberate work to reduce multi-agent drift and merge conflict. The repository has already acted on several items from its July 27 internal audit.

### 5. Clear compatibility and failure-mode documentation

Files such as the workshop client, regex mapper, EJS runtime, and migration code document real-world upstream quirks and the reasons behind design choices. The comments often identify exactly which assumptions were tested against actual content.

### 6. Responsive remediation history

Commit [`d1852867...`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/commit/d1852867f97fb9dff1068072ca3f13fb43ae299e) addressed a substantial earlier review: failed-turn progression, backup validation and rollback, raw model-text XSS, path containment on writes, prototype pollution, transactional snapshots, material accounting, race ordering, test-hook exposure, and swallowed asynchronous writes. This demonstrates that the project can execute a focused hardening pass.

---

## Priority findings

| ID        | Severity                                  | Area                    | Finding                                                                                       | Recommended release treatment                          |
| --------- | ----------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| SEC-01    | **Critical**                              | Workshop/UI             | Raw workshop replacements become executable HTML through `v-html`                             | Block workshop release until fixed                     |
| SEC-02    | **Critical**                              | Workshop/EJS            | `new Function` “sandbox” is intentionally escapable and unbounded                             | Disable for community content or replace runtime       |
| SEC-03    | **High**                                  | Dev server              | `/data` route can resolve outside `dataDir` and read arbitrary files                          | Patch immediately                                      |
| SEC-04    | **High**                                  | BFF/network             | Wildcard-CORS arbitrary-target proxy permits private/loopback access                          | Require exact origin and target policy                 |
| SEC-05    | **High**                                  | Dev server              | File-write APIs lack authentication, origin checks, validation, and limits                    | Replace or harden before broader use                   |
| REL-01    | **High**                                  | Release                 | Production build omits BFF and root `data/`; preview is not representative                    | Add a real production server and build smoke test      |
| PERF-01   | **Medium–High**                           | Workshop/rendering      | Untrusted regular expressions can cause catastrophic backtracking, amplified during streaming | Add execution budgets/isolation                        |
| SUPPLY-01 | **High while executable content remains** | Workshop supply chain   | Remote packages have no content signature or digest verification                              | Add signed manifests and immutable digests             |
| CI-01     | **Medium**                                | CI/testing              | CI omits build, browser E2E, coverage policy, dependency/secret/security checks               | Expand required checks                                 |
| DX-01     | **Medium**                                | Developer experience    | `npm run dev` is Windows-only; Node requirements are inconsistent                             | Make setup reproducible                                |
| DOC-01    | **Medium**                                | Documentation/licensing | Architecture is stale; license link is broken; root MIT license file is absent                | Correct before external adoption                       |
| PKG-01    | **Medium**                                | Packaging/repository    | Package metadata and repository size are inconsistent with an app-only project                | Mark private or define a real package/release boundary |

---

# Detailed findings

## SEC-01 — Workshop regex replacements create stored and streaming XSS

**Severity:** Critical  
**Confidence:** High  
**Affected paths:**

- [`src/sillytavern/workshop-regex-map.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/workshop-regex-map.ts)
- [`src/sillytavern/beautifier.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/beautifier.ts)
- [`src/ui/composables/useBeautify.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/composables/useBeautify.ts)
- [`src/ui/components/game/ChatFlow.vue`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/components/game/ChatFlow.vue)
- [`src/ui/stores/settings-store.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/stores/settings-store.ts)

### Evidence

The workshop regex mapper intentionally copies `replaceString` unchanged, preserves its enabled state, and does not strip HTML. The beautifier first escapes raw model text, but then applies replacement strings as trusted output. `useBeautify` returns the resulting HTML, and `ChatFlow.vue` renders both completed and streaming assistant content with `v-html`.

Escaping the original model text does **not** make a later replacement string safe. A replacement need not use a `<script>` element. Browser-executable attributes and active URL schemes are sufficient.

A harmless proof pattern would be:

```text
pattern: probe
replacement: <img src=x onerror="document.body.dataset.workshopProbe='1'">
```

When the pattern matches, the replacement is inserted as real HTML and the event handler runs.

The settings store persists `ApiEntry.apiKey` as part of the complete settings object in `localStorage` under `fated-poem-settings`. Any same-origin script can read it. The same script can also access IndexedDB saves, call the local BFF, change application state, or persist itself through installed rules.

### Impact

A workshop author, compromised workshop service, or modified local workshop file can obtain:

- AI provider API keys.
- Game saves, worldbooks, presets, and local metadata.
- Same-origin access to local development endpoints.
- The ability to modify UI, messages, and persistent installed content.
- A platform for local-network requests through the BFF.

This is a normal-install attack path, not a developer-console-only path.

### Recommendation

1. **Sanitize the final generated HTML after all regex substitutions.** Sanitizing only input text is insufficient.
2. Use a strict allowlist. Remove event attributes, scripts, styles, SVG/MathML, iframes, objects, embeds, forms, `javascript:` URLs, dangerous `data:` URLs, and unapproved inline styles.
3. Prefer a typed rendering model over arbitrary replacement HTML. For example, map rules to approved spans, emphasis, dialogue cards, and semantic tokens.
4. Disable imported rules by default until the user explicitly reviews and enables them.
5. Mark rules with provenance and trust state: built-in, locally authored, signed workshop, unsigned workshop.
6. Add Trusted Types and a restrictive CSP after `new Function` is removed.
7. Add regression tests for event handlers, malformed tags, SVG payloads, URL schemes, capture-group injection, and streaming rendering.

### Acceptance criteria

- No installed rule can introduce executable attributes or active content.
- Final HTML is sanitized in one central function immediately before DOM insertion.
- Built-in and community rules use the same security policy unless a narrowly scoped internal capability is explicitly documented.
- A test using the harmless `data-workshop-probe` payload cannot mutate the DOM.

---

## SEC-02 — Workshop EJS has ambient code execution and no execution budget

**Severity:** Critical  
**Confidence:** High  
**Affected paths:**

- [`src/sillytavern/ejs-runtime.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/ejs-runtime.ts)
- [`src/sillytavern/worldbook-loader.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/worldbook-loader.ts)
- [`src/ui/lib/workshop-client.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/lib/workshop-client.ts)
- [`src/ui/components/workshop/WorkshopDetailModal.vue`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/components/workshop/WorkshopDetailModal.vue)

### Evidence

The runtime compiles entire worldbook entries with `new Function`. It shadows direct references such as `window`, `document`, `fetch`, and `Function`, but passes native constructors including `Object` and `Array` into the template function.

The source header correctly states that this is not a security boundary and specifically notes constructor-constructor escape. A harmless proof is:

```ejs
<%= Object.constructor("return globalThis")().location.origin %>
```

The expression obtains the real global object despite the shadowed `globalThis` parameter.

The runtime is synchronous and runs on the main thread. A package can also execute an infinite loop or computationally expensive code and freeze the application. Catching exceptions does not help because an infinite loop never returns.

The workshop UI warns that community submissions are unreviewed, but the warning is framed around content/settings compatibility rather than code execution, credential access, or page control.

### Impact

A worldbook entry can:

- Reach `globalThis`, `fetch`, storage APIs, DOM APIs, and timers through recovered constructors/global objects.
- Read API keys and saved data.
- Exfiltrate data over the network.
- Invoke local endpoints and the arbitrary-target BFF.
- Permanently freeze the UI with unbounded synchronous execution.
- Mutate shared drafts and influence prompts in ways beyond the documented data contract.

### Recommendation

Do not execute untrusted workshop EJS with `new Function`.

Preferred options, in descending order:

1. **Replace EJS with a safe expression/template DSL.** Parse to an AST and implement only approved operators, conditionals, lookups, loops with explicit bounds, and pure helper functions.
2. If JavaScript compatibility is mandatory, run it in a **separate Worker-hosted isolated VM** such as QuickJS/WASM with:
   - no ambient host bindings,
   - explicit message-based capabilities,
   - wall-clock timeout,
   - instruction/memory limits,
   - termination on overrun,
   - immutable input snapshots,
   - schema-validated output.
3. A hardened SES compartment may help, but it must be independently threat-modeled and should still run off the main thread with termination controls.

Also:

- Disable EJS by default for community packages until the isolation design exists.
- Display an explicit “contains executable logic” permission screen.
- Record package trust, signer, requested capabilities, and last-reviewed version.
- Separate compatibility mode from safe mode; do not label parameter shadowing a sandbox.
- Make EJS-free content the default workshop format.

### Acceptance criteria

- Constructor chains cannot recover host globals.
- Template execution cannot access browser storage, DOM, network, timers, or the BFF unless an explicit narrow capability is granted.
- Infinite loops and excessive allocations are terminated without freezing the UI.
- Execution output is data-only and schema validated.
- Community EJS remains disabled when isolation is unavailable.

---

## SEC-03 — `/data` can escape `dataDir` and read arbitrary local files

**Severity:** High  
**Confidence:** High  
**Affected path:**

- [`vite.config.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/vite.config.ts)

### Evidence

The middleware is mounted with:

```text
server.middlewares.use('/data', handler)
```

Connect removes the matched mount prefix before invoking the handler and ensures the remaining URL starts with `/`. The handler then:

1. Parses `req.url`.
2. Attempts to remove `/data/`, which is already absent.
3. Passes the leading-slash path to `path.resolve(dataDir, relPath)`.
4. Checks only whether `relPath` contains `..`.

On POSIX systems, resolving a leading-slash second argument discards `dataDir`. Therefore:

```text
request: /data/etc/passwd
handler path: /etc/passwd
resolved path: /etc/passwd
```

If the file exists, it is read and returned. The same class applies to other absolute paths.

The write routes already use a canonical `relative(...)` containment check, but the read route does not.

Connect's mount behavior is visible in its dispatcher source:  
https://raw.githubusercontent.com/senchalabs/connect/master/index.js

### Impact

While the Vite server is running, a caller that can reach the route can read files accessible to the development process. Same-origin workshop code can exploit it directly. Exposure is worse when Vite is bound beyond loopback, but loopback-only binding does not mitigate same-browser or same-origin compromise.

### Recommendation

- Use `req.originalUrl` or deliberately normalize the mount-relative URL.
- Remove leading separators before resolution.
- Apply canonical containment with `path.relative`.
- Resolve real paths to prevent symlink escapes.
- Allow only expected `.json` files under explicit directories.
- Return `400` or `403` instead of falling through to unrelated middleware.
- Use asynchronous I/O and avoid synchronous file reads in request handling.

A robust pattern is conceptually:

```text
candidate = realpath(resolve(dataDir, normalizedRelativePath))
require candidate to be inside realpath(dataDir)
require allowed extension and file class
```

### Acceptance criteria

Requests containing absolute paths, encoded separators, traversal segments, Windows drive syntax, UNC syntax, or symlink escapes cannot leave `dataDir`.

---

## SEC-04 — The BFF is a wildcard-CORS arbitrary-target proxy

**Severity:** High  
**Confidence:** High  
**Affected paths:**

- [`server/app.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/server/app.ts)
- [`server/routes/proxy.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/server/routes/proxy.ts)

### Evidence

The Hono app allows `origin: '*'` and permits `X-Target-Base-URL`, `Authorization`, and `api-key` headers. The forwarding route accepts any HTTP or HTTPS base URL. It intentionally permits localhost and private-network IPs for local model servers.

The blocklist contains only several exact cloud metadata hostnames/IPs. It does not cover:

- All private, loopback, link-local, multicast, or special-use ranges.
- DNS rebinding.
- IPv6-mapped and equivalent address forms.
- Trailing-dot/equivalent hostnames.
- Redirects to blocked destinations; `fetch` follows redirects by default.
- User-configured allowlists.
- Per-request upstream timeouts.
- Upstream cancellation tied to the client signal.
- Request/response size policies.

The original code comment assumes there is no same-origin hostile-code chain because raw model XSS was fixed. Workshop regex XSS and EJS invalidate that assumption.

### Impact

When the local server is running, an allowed browser origin—or any same-origin injected code—can use the BFF as:

- A CORS bypass.
- A local/private-network request primitive.
- A port/service discovery mechanism.
- A route to unauthenticated local model and administration APIs.
- A resource-exhaustion vector through hanging upstreams.

Wildcard CORS makes cross-origin browser use an explicit supported behavior rather than an accidental side effect. Browser Private Network Access behavior may reduce some cross-site cases, but it is not an application security boundary and varies by context.

### Recommendation

- Remove wildcard CORS. Allow only the exact local application origin.
- Require a per-launch unpredictable bearer token or equivalent origin-bound session.
- Register provider base URLs through settings, then forward only to registered targets by opaque ID.
- Resolve DNS and validate every resulting IP before connection.
- Validate every redirect destination or set redirects to manual.
- Block private/link-local/loopback by default; permit explicit localhost providers only through a separate opt-in mode.
- Propagate cancellation and enforce connection, header, idle, and total timeouts.
- Add request and response size limits.
- Restrict methods and headers to the minimum needed.
- Log policy decisions without logging API keys.

### Acceptance criteria

A foreign origin cannot read BFF responses. A request cannot choose an arbitrary destination. Redirect and DNS-rebinding tests cannot reach blocked address ranges. Client cancellation terminates the upstream request.

---

## SEC-05 — Development file-write endpoints lack an authorization boundary

**Severity:** High  
**Confidence:** High  
**Affected path:**

- [`vite.config.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/vite.config.ts)

### Evidence

`/api/worldbooks` and `/api/defaults` accept `POST` or `PUT`, accumulate the entire request body into a string, and write it directly to repository JSON files.

The path containment improvement is good, but the routes still lack:

- Authentication or a per-launch token.
- `Origin`/`Host` validation.
- CSRF protection.
- A required JSON content type.
- JSON parsing before persistence.
- Schema validation.
- Body-size limits.
- Atomic temp-file/rename writes.
- Concurrency/version checks.
- Durable backup or rollback at the filesystem layer.

Because `POST` with `text/plain` can be a simple cross-origin request, an external page may be able to cause writes without reading the response, subject to browser local-network policy. Same-origin injected workshop code can certainly call these routes.

### Impact

An attacker can overwrite default agent configuration or worldbook files, corrupt the development checkout, persist malicious content, or exhaust memory/disk with a large request. A partial process failure can leave truncated files.

### Recommendation

The safest design is to remove browser-driven writes to source-controlled files and expose them through a developer CLI or authenticated desktop host.

If the endpoints remain:

- Bind only to loopback.
- Require an unpredictable per-launch token and exact Origin.
- Reject absent/foreign Origin where browser access is expected.
- Require `application/json`.
- Enforce a small body limit.
- Parse and schema-validate before writing.
- Write to a temporary file, fsync if necessary, then atomically rename.
- Maintain a backup/version and use optimistic concurrency.
- Rate limit and log write actions.
- Keep the route out of production builds unless explicitly enabled.

---

## REL-01 — The production build is not a complete runnable application

**Severity:** High  
**Confidence:** High  
**Affected paths:**

- [`package.json`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/package.json)
- [`vite.config.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/vite.config.ts)
- [`src/sillytavern/worldbook-loader.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/worldbook-loader.ts)
- [`src/ui/stores/settings-store.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/stores/settings-store.ts)
- [`docs/planning/2026-07-30-bff-api-refactor-plan.md`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/docs/planning/2026-07-30-bff-api-refactor-plan.md)

### Evidence

- The Hono BFF and `/data` middleware are registered only in Vite's `configureServer` hook.
- There is no `configurePreviewServer` hook.
- `npm run preview` therefore does not reproduce the development APIs.
- Vite copies the configured `public/` directory into `outDir`; the repository's `data/` directory is at the project root and no copy step is configured.
- Runtime code fetches `/data/worldbooks/...` and `/data/defaults/...`.
- No standalone `server/index.ts`, `server.js`, `start` script, or `start.bat` exists.
- The planning document describes a future production server on port 8787, but the implementation is not present.
- CI never runs `npm run build`.

Official Vite references:

- Static assets and `public/`: https://vite.dev/guide/assets.html
- Preview middleware hook: https://vite.dev/guide/api-plugin.html#configurepreviewserver

### Impact

A successful unit-test/typecheck run does not establish that the built application can:

- Load default agent configuration.
- Load worldbooks.
- Call chat, embedding, model, or status APIs.
- Perform any source-file-backed development operations.
- Run from the documented preview command as an integrated product.

Silent fetch fallbacks may make the result appear partially functional while core content is absent.

### Recommendation

Choose and document one production architecture:

**Option A: standalone local server**

- Implement a Node entry point that serves `dist-ui`, read-only packaged data, and the hardened BFF.
- Store mutable user content in IndexedDB or an application data directory, not the source tree.
- Add `npm run start`.
- Bind to loopback by default.
- Add health/status endpoints and graceful shutdown.

**Option B: desktop host**

- Use a desktop shell with an authenticated IPC boundary and OS credential storage.
- Vendor all static assets.
- Package data and migrations explicitly.
- Remove generic HTTP write endpoints.

In either case:

- Add a build-time data-copy step or move immutable static data under a deliberate public asset boundary.
- Run the built artifact in CI and execute a smoke test against it.
- Make `npm run preview` clearly UI-only if it remains so.

### Acceptance criteria

A clean checkout can run one documented build/start sequence, load required data, complete a provider connection test, and open a game without relying on Vite development middleware.

---

## PERF-01 — Untrusted regexes can freeze the streaming renderer

**Severity:** Medium–High  
**Confidence:** High  
**Affected paths:**

- [`src/sillytavern/workshop-regex-map.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/workshop-regex-map.ts)
- [`src/sillytavern/beautifier.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/beautifier.ts)
- [`src/ui/composables/useBeautify.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/composables/useBeautify.ts)

### Evidence

Workshop patterns are accepted if `new RegExp` can compile them. Compilation does not detect catastrophic backtracking. The beautifier applies every active rule synchronously to the message. During generation, `beautifyStreamingText` reprocesses the current accumulated text as updates arrive.

A malicious or accidental pathological expression can therefore consume the main thread repeatedly as the stream grows.

### Impact

- UI freezes.
- Stop/cancel controls become unresponsive.
- Long messages magnify cost.
- One installed rule affects every matching conversation.
- A package can create a denial of service without escaping the EJS runtime or using HTML.

### Recommendation

- Execute community regexes in a Worker with termination and time budget.
- Prefer RE2-compatible syntax through RE2/WASM if compatibility permits.
- Reject unsupported constructs and set pattern/replacement/input limits.
- Add static risk screening as a warning, not as the only defense.
- Do not rerun every rule against the full accumulated stream for every token/chunk.
- Consider plain escaped streaming followed by one final beautification pass.
- Record per-rule timing and automatically disable repeat offenders.

### Acceptance criteria

A known catastrophic-backtracking fixture cannot block the UI, and the offending rule is terminated/disabled with a visible diagnostic.

---

## SUPPLY-01 — Workshop packages lack authenticity and integrity guarantees

**Severity:** High while packages remain executable; Medium after sandboxing  
**Confidence:** High  
**Affected paths:**

- [`src/ui/lib/workshop-client.ts`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/lib/workshop-client.ts)
- [`src/ui/components/workshop/WorkshopDetailModal.vue`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/components/workshop/WorkshopDetailModal.vue)

### Evidence

The client trusts a hardcoded Cloudflare Worker for metadata and trusts the returned download URL for content. Payloads are treated as version-immutable and cached by URL, but there is no package digest, signature, signer identity, transparency record, or pinned expected hash.

The project detail UI exposes tags, descriptions, and previews, but those fields are not a security review and do not authenticate the payload bytes eventually installed.

### Impact

A compromised worker, account, CDN path, or publishing pipeline can replace content. While EJS and replacement HTML are executable, this becomes a remote code-execution supply-chain path after ordinary user confirmation.

### Recommendation

- Include a cryptographic digest for every payload in the signed manifest.
- Sign manifests with publisher keys and support revocation.
- Pin the exact version and digest shown in the install confirmation.
- Verify bytes before parsing or installing.
- Keep an immutable local copy of the previously installed package for rollback.
- Show signer, trust level, permissions, executable-content flags, and changed capabilities on update.
- Separate platform moderation from cryptographic authenticity.
- Keep sandboxing and sanitization even for signed packages; signatures identify authors, not benevolence.

---

## CI-01 — CI is strong but does not test the release or security boundary

**Severity:** Medium  
**Confidence:** High  
**Affected path:**

- [`.github/workflows/ci.yml`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/.github/workflows/ci.yml)

### Current strengths

The workflow runs:

- `npm ci`
- TypeScript typecheck
- Vue SFC typecheck
- Prettier check
- ESLint
- Full Vitest run

### Gaps

- No `npm run build`.
- No built-artifact smoke test.
- No real-browser E2E runner declared in package scripts.
- No coverage thresholds.
- No dependency audit/update workflow in the repository.
- No CodeQL or equivalent SAST workflow.
- No repository secret-scanning workflow/configuration visible in source.
- No security regression tests for the BFF, Vite file APIs, HTML sanitization, or EJS isolation.
- GitHub Actions are pinned to major tags rather than immutable commit SHAs.
- Lint rules allow explicit `any`, and unused-variable/empty-block rules are warnings; CI does not use a zero-warning policy.

### Recommendation

Add required jobs for:

1. Production build.
2. Start built artifact and run health/data/API smoke tests.
3. Playwright browser smoke flows.
4. Security regression suite.
5. Dependency review and automated update policy.
6. Secret scanning and CodeQL.
7. Coverage reporting with targeted thresholds for security-critical modules.
8. Optional bundle-size and repository-artifact budgets.

---

## DX-01 — Source setup is not reproducible as documented

**Severity:** Medium  
**Confidence:** High  
**Affected paths:**

- [`README.md`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/README.md)
- [`package.json`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/package.json)
- [`dev.bat`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/dev.bat)
- [`package-lock.json`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/package-lock.json)

### Evidence

- `npm run dev` invokes `dev.bat`, so the primary script is Windows-only.
- The README presents source startup as a general Node workflow and mentions the batch file only as an additional Windows option.
- The README says Node 18+, while the lockfile contains dependencies with Node 20.19+ engine declarations.
- `package.json` has no `engines`, package-manager pin, `.nvmrc`, or Volta configuration.
- The README uses `npm install`, while CI relies on the lockfile through `npm ci`.

### Recommendation

- Make `"dev": "vite --port 5173"` cross-platform.
- Keep the current helper as `"dev:win"` if its port cleanup is useful.
- Declare and enforce the supported Node range, likely Node 20.19+ after verification.
- Add `.nvmrc`, `.node-version`, or Volta metadata.
- Document `npm ci` for reproducible contributor setup.
- Provide Linux/macOS/Windows startup verification in CI.
- Do not silently terminate unrelated processes across a port range in the default script.

---

## DOC-01 — Architecture and licensing documentation are inconsistent

**Severity:** Medium  
**Confidence:** High  
**Affected paths:**

- [`docs/ARCHITECTURE.md`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/docs/ARCHITECTURE.md)
- [`README.md`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/README.md)
- [`docs/《命定之诗》内容二创与素材使用授权协议.md`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/docs/%E3%80%8A%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97%E3%80%8B%E5%86%85%E5%AE%B9%E4%BA%8C%E5%88%9B%E4%B8%8E%E7%B4%A0%E6%9D%90%E4%BD%BF%E7%94%A8%E6%8E%88%E6%9D%83%E5%8D%8F%E8%AE%AE.md)

### Evidence

- The architecture document still describes a React GameView and a Vanilla observer store and explicitly says Pinia is not used.
- The current application is Vue 3/Pinia.
- The README's narrative-content license link points to the repository root, while the file is under `docs/`.
- `package.json` declares MIT and the README says `src/` is MIT, but there is no root `LICENSE` or `LICENSE.md`.
- No root `SECURITY.md` exists.

### Impact

New contributors receive conflicting architectural instructions. External users cannot reliably determine the applicable license text from the repository root. Security reporters have no documented private reporting path.

### Recommendation

- Rewrite or archive/version the stale architecture document.
- Generate an architecture index from current module boundaries and ADRs.
- Fix the README license link.
- Add the full MIT license text at the root and clearly define which paths it covers.
- Add an explicit content-license notice for non-code assets.
- Add `SECURITY.md` with supported versions and a private disclosure channel.
- Consider SPDX headers or a machine-readable `REUSE` layout if dual licensing expands.

---

## PKG-01 — Package and repository boundaries are unclear

**Severity:** Medium  
**Confidence:** High  
**Affected paths:**

- [`package.json`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/package.json)
- [`.gitattributes`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/.gitattributes)
- [`.gitignore`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/.gitignore)
- [`index.html`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/index.html)

### Evidence

- The repository is roughly 374 MiB.
- `.gitattributes` contains no Git LFS rules.
- `package.json` is not marked `private`.
- There is no `files` allowlist or exports map.
- `main` points to `dist/sillytavern/index.js`, but the default `build` script runs only Vite and writes `dist-ui`; the engine output requires a separate `build:engine`.
- The app loads Google Fonts and Font Awesome from third-party CDNs at runtime without local vendoring or integrity metadata.

### Impact

An accidental `npm publish` could produce a large, incomplete, or incorrectly built package. Large tracked references/process artifacts increase clone and CI cost. A future offline desktop build will still depend on third-party web assets, and those assets complicate CSP and supply-chain hardening.

### Recommendation

If this is an application repository:

- Set `"private": true`.
- Remove or clarify `main`.
- Publish releases through a dedicated packaging workflow.
- Vendor fonts/icons required by the application.
- Move large reference/process artifacts to Git LFS, release assets, or a separate archive repository.

If it is also an engine package:

- Define `exports`, `types`, `files`, and a deterministic `prepack`.
- Make the default build produce all declared entry points.
- Add package-consumer tests from the packed tarball.

---

# Combined attack chain

The following chain is currently plausible after a user installs a malicious or compromised workshop project:

```text
Workshop package
    ├── EJS → new Function → constructor escape → globalThis
    └── regex replacement → v-html → event-handler XSS
                    │
                    ▼
        Same-origin browser privileges
            ├── localStorage API keys
            ├── IndexedDB game saves/content
            ├── UI and installed-rule persistence
            ├── /api/worldbooks and /api/defaults writes
            ├── /data absolute-path file read
            └── wildcard-CORS arbitrary-target BFF
                    │
                    ▼
          Provider credentials and local/private services
```

This chain explains why the BFF's previous assumption—“raw model XSS is fixed, therefore no hostile same-origin code exists”—is no longer valid. The raw-model escape fix remains useful, but workshop-authored HTML and JavaScript bypass it.

---

# Testing assessment

## Current strengths

- Large and actively maintained Vitest suite.
- Extensive pure-function tests for engine behavior.
- Component/store tests using jsdom where needed.
- Fake IndexedDB support for persistence tests.
- Deterministic replay and anti-`Math.random` testing in combat-v3.
- Tests added alongside recent workshop caching and EJS work.
- CI uses lockfile-based installation and both TypeScript checkers.

## Highest-value missing tests

### Security regression tests

- Final HTML removes `onerror`, `onclick`, `javascript:`, SVG/MathML active content, iframes, and unsafe styles.
- EJS cannot recover `globalThis`, constructors, timers, storage, DOM, or network.
- EJS infinite loops are terminated.
- Regex catastrophic backtracking cannot block the UI.
- `/data/etc/passwd`, encoded paths, drive paths, UNC paths, and symlink escapes are rejected.
- Foreign `Origin` cannot use BFF or write APIs.
- Redirect-to-private-address and DNS-rebinding scenarios are rejected.
- Oversized write/proxy bodies return `413`.
- Client cancellation aborts the upstream model request.

### Built-artifact tests

- Build succeeds from a clean checkout.
- Built app serves default agent config and worldbooks.
- Built app's BFF health check works.
- A mocked OpenAI-compatible streaming request reaches the UI.
- Workshop install/update/uninstall works in a real browser.
- IndexedDB migration and backup/restore work across refresh.
- Offline startup either succeeds fully or shows an explicit supported limitation.

### Accessibility and UX tests

- Keyboard navigation and focus management for workshop/install modals.
- Reduced-motion behavior.
- Screen-reader announcements for failed installs and security warnings.
- Clear distinction between “content package” and “executable package.”

---

# Release and operational assessment

## Current release posture

The README correctly labels the project as a development version and says no standalone package exists. That honesty is good. The technical problem is that the repository still exposes `build` and `preview` scripts that look production-like but do not reproduce the full system.

Before publishing a release, define:

- Supported OS and Node/runtime versions.
- Local-only versus LAN-access behavior.
- Where API keys live.
- Where mutable user data lives.
- How immutable built-in data is packaged.
- Workshop trust and update policy.
- Backup/restore compatibility.
- Security update and disclosure process.
- CSP and offline asset strategy.

## Credential strategy

Moving keys from `localStorage` to IndexedDB alone would not protect them from same-origin code. Better options are:

- OS keychain/credential vault in a desktop host.
- Server-process memory plus opaque provider IDs.
- Session-only browser storage for users who prefer not to persist keys.
- Explicit export rules that never include secrets by default.

This is defense in depth; it does not replace fixing XSS and EJS isolation.

---

# Recommended remediation sequence

## Gate 0 — Contain immediate risk

1. Feature-flag community EJS off.
2. Disable workshop HTML replacements or render them as escaped text until final-output sanitization exists.
3. Patch `/data` canonical containment.
4. Require exact origin and a per-launch token for all local privileged routes.
5. Remove wildcard CORS and arbitrary target selection from individual requests.
6. Add body limits and JSON/schema validation to write endpoints.
7. Add the above cases as regression tests.

## Gate 1 — Make the release artifact real

1. Implement the standalone server or desktop host.
2. Package/copy immutable data deliberately.
3. Move mutable content out of the source tree.
4. Add `start` and a single documented clean-build workflow.
5. Add `npm run build` and built-artifact smoke tests to CI.
6. Vendor required fonts/icons and establish CSP.

## Gate 2 — Redesign workshop trust

1. Replace EJS with a safe DSL or isolated terminating VM.
2. Replace arbitrary HTML replacements with typed presentation primitives or strict sanitization.
3. Add regex execution budgets/isolation.
4. Add signed manifests and payload digests.
5. Add permission/trust UI, signer identity, update diffs, and rollback.
6. Treat compatibility with unsafe upstream content as an explicit opt-in mode.

## Gate 3 — Improve project adoption and maintenance

1. Make development scripts cross-platform.
2. Pin Node/package-manager requirements.
3. Update architecture documentation.
4. Add root license and security policy.
5. Clarify package versus application boundaries.
6. Reduce repository weight and move archival artifacts.
7. Add browser E2E, coverage policy, dependency review, SAST, and secret scanning.

---

# Verification checklist

The following should pass in a clean environment before declaring the next release candidate:

```bash
npm ci
npm run typecheck
npm run typecheck:vue
npm run format:check
npm run lint
npm run test:run
npm run build
npm run start
```

Then verify:

- [ ] Built app loads all required `/data` resources.
- [ ] Provider connection test works through the production BFF.
- [ ] Streaming story generation renders safely.
- [ ] Workshop HTML probes do not execute.
- [ ] Workshop EJS cannot access host globals.
- [ ] Infinite EJS and pathological regex fixtures terminate safely.
- [ ] Foreign origins receive no privileged CORS access.
- [ ] Local write APIs require authentication and valid schemas.
- [ ] `/data` cannot read outside its root.
- [ ] Redirect/DNS SSRF tests cannot reach blocked networks.
- [ ] API keys are not included in default exports or logs.
- [ ] Browser E2E covers create → game → save → reload → rollback.
- [ ] Workshop install → enable → update → uninstall is covered.
- [ ] Backup import failure restores the original data.
- [ ] Offline/third-party asset behavior matches the documented support level.

---

# Source index

## Current baseline and project metadata

- [Latest reviewed commit](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/commit/097b0e8a294d7ba8bd5c50cdf128fe06305713c5)
- [Repository root](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey)
- [`package.json`](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/package.json)
- [CI workflow](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/.github/workflows/ci.yml)

## Security-critical paths

- [Vite development middleware](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/vite.config.ts)
- [Hono app/CORS](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/server/app.ts)
- [BFF forwarding policy](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/server/routes/proxy.ts)
- [EJS runtime](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/ejs-runtime.ts)
- [Worldbook EJS execution](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/worldbook-loader.ts)
- [Workshop regex mapping](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/workshop-regex-map.ts)
- [Beautifier](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/sillytavern/beautifier.ts)
- [Vue beautification composable](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/composables/useBeautify.ts)
- [Chat `v-html` rendering](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/components/game/ChatFlow.vue)
- [Settings/API-key persistence](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/stores/settings-store.ts)
- [Workshop network client](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/lib/workshop-client.ts)
- [Workshop project detail UI](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/src/ui/components/workshop/WorkshopDetailModal.vue)

## Documentation and governance

- [README](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/README.md)
- [Architecture document](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/docs/ARCHITECTURE.md)
- [Repository governance plan](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/docs/planning/2026-07-31-repo-management.md)
- [Previous comprehensive review](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/docs/reviews/2026-07-27-comprehensive-repository-review.md)
- [Prior security/data-integrity remediation](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/commit/d1852867f97fb9dff1068072ca3f13fb43ae299e)
- [Production BFF plan](https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey/blob/097b0e8a294d7ba8bd5c50cdf128fe06305713c5/docs/planning/2026-07-30-bff-api-refactor-plan.md)

---

## Final assessment

The repository is technically promising and shows real engineering maturity in deterministic systems, tests, migration safety, documentation, and iterative remediation. The current blocker is not general code quality; it is the security model of community content and the privileged local development surface around it.

Treat workshop packages as untrusted software, not merely data. Once that assumption is reflected in the runtime, UI, BFF, build architecture, and tests, the rest of the repository is in a good position to support a credible public release.
