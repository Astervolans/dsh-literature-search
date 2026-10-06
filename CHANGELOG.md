# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.3] — 2026-10-07

### Changed

- **The configuration page moved from Settings → 内置插件 to the Plugins panel.**
  The client bundle used to contribute a tab to `settings.plugins.tab`, which put
  the page beside the built-in inventory under **Settings → Built-in plugins** —
  a section that only exists to *report* what a deployment ships. DSH's own
  plugin manager is explicit about the split: the sidebar 插件 / Plugins panel is
  where plugins are configured ("在这里配置官方插件，安装和管理其他插件。内置插件列表及运行状态可在
  「设置 → 内置插件」中查看").

  The page now registers into `plugins.row.config`, the keyed slot
  `@deepseek-ai/dsh-client-ui-plugin-manager` declares for a row a bundle owns,
  with the key `` `${package name}#${row id}` `` —
  `@astervolans/dsh-literature-search#literature-search` here. That is the same
  string the panel recomputes through its own `rowConfigKey(bundle, rowId)` to
  decide whether a row gets a configure control, so the entry now appears where
  it belongs: **插件 → `@astervolans/dsh-literature-search` → the
  `literature-search` row**. Nothing else moved — the route tree, the
  `literature-search` settings namespace, the credential slots and every saved
  key are unchanged.

  The slot owner asks for two views, so the bundle now renders
  `PluginConfigViewProps.view`: a hook-free one-liner for `summary` (the row's
  description fallback) and the full form for `page`. The branch is a component
  boundary, not an early return inside the form, because a component that calls
  `useState` and then returns a string would change its hook count between views.
  `test/client.test.mjs` pins the slot name, the key (against `package.json` and
  `cordis.patch.yml`, both halves), and the two views: a key mismatch costs the
  row its configure control *without raising an error*, so a test is the only
  place it can be caught before a user notices a row that cannot be opened.

### Fixed

- **DSH 0.2.0 disabled the plugin outright.** Starting with 0.2.0, DSH
  pre-flights every profile row before loading it:
  `@deepseek-ai/dsh-app-boot`'s `evaluatePluginCompatibility()` tests each
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer against the running runtime
  with `includePrerelease` and disables the whole row when one fails. Both
  declared peers were `^0.1.0-rc.6`, whose semantic upper bound is `<0.2.0`;
  on a 0.2.0 host the bundle layer was skipped, so no `pubmed_*` / `scholar_*`
  tool, no prompt-guidance section and no `/plugin/literature-search` route
  existed at all. They are now `>=0.1.7-rc.1 <0.3.0`, covering the `0.1.7`
  line and the whole `0.2.0` line. `@deepseek-ai/cordis` and
  `@deepseek-ai/schemastery` are not gated and keep their ranges. No runtime
  code changed: the settings page is already derived from the exported
  `Config`, and the client bundle already registers under the scoped package
  name.

  > 0.3.3 carries both changes. It was prepared on 2026-09-29 and never
  > published — no `v0.3.3` tag, no GitHub release, nothing on npm — so the two
  > shipped together rather than as a phantom version.

## [0.3.2] — 2026-09-28

### Fixed

- **A cleared key slot still read as "已配置（保存在设置中）".** `collectSlot`
  treated the settings descriptor's secret metadata (`secrets[].set`) as proof of
  a stored key, but the host reports `set: true` for any `role('secret')` field
  merely *present* in the projected value — and this namespace declares
  `pubmedApiKey` / `scholarSerpApiKey` as `default('')`, so the flag was already
  true before a key was ever entered and stayed true after a clear. A non-empty
  inline value — what `resolveSecret` actually reads — now decides the
  `settings-inline` state; the flag stays in `facts` for the diagnostic line,
  which prints `settings-secret=set` or `settings-secret=declared/empty`.

- **Clearing a slot left an inline key live.** `POST /credential` skipped the
  inline-field cleanup whenever `clear: true`, so a value in `pubmedApiKey` /
  `scholarSerpApiKey` — which outranks the credential store in `resolveSecret` —
  survived the clear while the card reported the slot as cleared. A clear now
  empties both layers.

### Added

- **Regression tests** in `test/web.test.mjs`: a declared-but-empty secret slot
  is not configured, a genuinely set inline key still reports the
  `settings-inline` state, and a clear with an inline key present writes it away.

## [0.3.1] — 2026-09-28

### Fixed

- **0.3.0's rename broke the client bundle: the Settings card never loaded and
  the desktop host disabled the bundle.** After the rename, the profile's
  `cordis.patch.yml` row named `@astervolans/dsh-literature-search`, but
  `lib/client.js` still registered itself as `dsh-literature-search`.

  `@deepseek-ai/dsh-client-modules` keys a boot-graph row by the *package name*
  the row resolved to and arrives it on that id: once the bundle script has run,
  `arrive()` checks `factories.has(rowId)`. A factory filed under the pre-rename
  id therefore looked like a bundle that "loaded without registering", so the
  loader retried the row on its one-resource URL. The script executed a second
  time, `register()` refused the duplicate, and the page aborted with

  ```
  Uncaught Error: client-modules: duplicate factory registration for
    "dsh-literature-search" (bundle executed twice without invalidate?)
  web boot: 1 entry did not activate
  @astervolans/dsh-literature-search: import failed (see console for the import error)
  ```

  The desktop host then wrote the plugin into `desktopNextDeselectedBundles`
  ("Disabled bundle for desktop") and restored a healthy start by leaving the
  plugin switched off — which is what made the install look like "dsh will not
  start". The registration id is now `package.json`'s `name`, matching the
  convention the loader implements (its own bootstrap bundle registers
  `@deepseek-ai/dsh-client-modules`).

### Added

- **Client-registration contract tests** in `test/client.test.mjs`. One asserts
  the bundle's registration id equals `package.json#name`; the other replays the
  loader's two load-bearing rules (a row is keyed by package name, a second
  registration throws) against the real bundle, so the 0.3.0 failure mode is now
  a red test instead of a broken boot. Verified by running the suite against the
  shipped 0.3.0 bundle: both cases fail there and pass on the fix.

### Changed

- The 0.3.0 entry below claimed the rename left "the client module id" alone.
  That claim was wrong and is the defect this release fixes — the client module
  identity had to move with the package name, exactly like the patch row's
  `name`. The README, the Chinese README and `cordis.patch.yml` now state which
  identifiers stay unscoped and which two must be the scoped name.

## [0.3.0] — 2026-09-27

### Changed

- **BREAKING: the npm package is renamed `dsh-literature-search` →
  `@astervolans/dsh-literature-search`.** GitHub Packages only accepts scoped npm
  packages, so the unscoped name can never be published there. The scoped name is
  used on npmjs.org as well, which keeps a single install command for both
  registries.

  The plugin's **runtime identity is deliberately unchanged**: the exported `name`
  (`literature-search`), the settings namespace, the `/plugin/literature-search`
  route tree, the `pubmedTool` value sent to NCBI and the diagnostics directory
  (`$DSH_HOME/.dsh-literature-search`) all stay unscoped, so an existing profile
  keeps its configuration and its saved keys.

  > **Corrected in 0.3.1:** this entry originally listed "the client module id"
  > among the identifiers that stay unscoped. That was wrong — the client
  > bundle's registration id must be the package name the loader resolves, and
  > leaving it unscoped is what broke the Settings card and the web boot. See
  > the 0.3.1 entry above.

  Two things had to move with the name, because the cordis loader resolves them:
  the `dsh.bundle.patch` row's `name` in `cordis.patch.yml` (the module specifier
  imported from the profile directory, where only the scoped package exists) and
  the copy target in `install.ps1`/`uninstall.ps1`
  (`node_modules\@astervolans\dsh-literature-search`). `install.ps1` rewrites a
  pre-0.3.0 unscoped row in place, and `uninstall.ps1` also removes a pre-0.3.0
  copy. `test/config.test.mjs` already asserts `row.name === package.json.name`,
  so the pair cannot silently diverge again.

### Added

- **GitHub Packages publishing.** `.github/workflows/release-package.yml` runs on
  `release: created` (plus `workflow_dispatch`) and publishes to
  `https://npm.pkg.github.com` with the workflow's own `GITHUB_TOKEN` — no secret
  and no token rotation. Re-running an already-published version is a no-op. An
  opt-in `publish-npmjs` job (repository variable `NPMJS_TRUSTED_PUBLISHING=true`)
  publishes to npmjs.org through trusted publishing.
- `publishConfig.access: public`, required for a scoped package on npmjs.org.

### Fixed

- **`npm pack --json` shape drift in the CI packaging gate.** npm ≤ 11 emits an
  array while npm ≥ 12 emits an object keyed by package name, so the `package`
  job's `require('./pack.json')[0]` would have thrown a `TypeError` on a runner
  with a newer npm. Both the `package` job and the new release workflow now accept
  either shape.

## [0.2.5] — 2026-09-25

### Fixed

- **The settings page failed on DSH 2.x with `settings namespace
  "literature-search" is not registered`.** The plugin called
  `ctx.settings.register(ns, Config, …)`, a service method DSH 2.x removed. The
  call threw `TypeError: ctx.settings.register is not a function`, the plugin's
  own `try/catch` swallowed it, and every `GET /plugin/literature-search/config`
  then answered `503 settings namespace "literature-search" is not registered`
  even though the tools themselves kept working.

  A plugin's page is no longer registered by hand: DSH derives it from the
  exported `Config` schema, and only offers the fields carrying `meta.volatile`.
  Two things therefore had to change:

  - Every `Config` field is now marked live through a guarded `live()` helper.
    `.volatile()` exists in schemastery ≥ 3.18.4 only, and a profile can hoist
    an older copy above the installation's one, so the helper falls back to
    `.extra('volatile', true)`, which writes the same `meta.volatile` flag on
    every version. An unguarded `.volatile()` would have replaced one activation
    failure with another.
  - The runtime no longer reads a `scope` returned by the settings service. Live
    values arrive as cosmokit volatile references in the entry config, so every
    read re-projects them (`plainConfig`/`unwrapField`) and a changed projection
    drops the cached PubMed/Scholar clients. That keeps the documented
    "saved keys and provider switches apply immediately" behaviour without any
    watcher API.

- **The routes looked the page up under a hard-coded namespace.** DSH keys a
  plugin's page by its profile entry id, so `settingsNs` is now resolved from
  the owning fiber entry and falls back to `SETTINGS_NS` only when it cannot be
  read. An entry installed under a different id (or renamed later) no longer
  breaks the card.

- The `503` body now carries a `hint` explaining the actual contract (the plugin
  must be active and declare at least one volatile field), because the old
  message pointed at a namespace that was never going to be registered.

### Added

- Test coverage for the DSH 2.x contract: the exported schema must flag every
  field volatile, a settings service **without** `register` must still mount the
  routes and expose the page, the namespace must follow the entry id, and
  registration-time switches (`enabled`, `scholarEnabled`, …) must never
  re-register tools on a live write. The settings stand-in now throws if
  `register` is called at all, so the regression cannot come back silently.

## [0.2.4] — 2026-09-13

### Fixed

- **The npm package page showed the Chinese README.** npm selects the package
  readme by globbing `{README,README.*}` in the package root and taking the
  first result whose name ends in a markdown extension — and in that glob's
  order `README.zh-CN.md` sorts **before** `README.md`. So 0.2.3 went out with
  the translation as its readme. The Chinese README now lives at
  `docs/README.zh-CN.md`, outside the glob's non-recursive pattern, and
  `npm pack` was re-checked against npm's own selection logic to confirm
  `README.md` is chosen. This is a display-only fix: the shipped code in 0.2.3
  is unchanged and worked correctly.

## [0.2.3] — 2026-09-13

First release published to npm. Installing is now
`dsh plugin --profile desktop add dsh-literature-search`: that command forwards
to pnpm inside the profile and reconciles the bundle layer list by installed
state, so a dependency declaring `dsh.bundle` joins the stack on its own.

### Added

- **English README** as the primary `README.md`, with the Chinese original kept
  in full as `README.zh-CN.md`. The two link to each other.
- `docs/` now ships in the package, so the `docs/API-RESEARCH.md` link in the
  README resolves for anyone who installs from npm rather than cloning.
- `dsh-plugin` keyword, matching the GitHub topic used for catalog discovery.

### Changed

- **The DSH peer dependencies are now marked optional** via
  `peerDependenciesMeta`. They are supplied by the DSH runtime, and without this
  npm tries to resolve their own peer graph on install — which fails with an
  `ERESOLVE` conflict for `@deepseek-ai/dsh-tools`. Marking them optional keeps
  `npm install dsh-literature-search` working while preserving the declaration
  for hosts that do resolve them.
- The README install section leads with the npm command and keeps `install.ps1`
  as the documented offline route.

### Security

- `npm publish` is now gated behind `prepublishOnly`, which runs the full
  offline suite, so a broken package cannot be published by accident.

## [0.2.2] — 2026-09-13

### Fixed

- **The settings card was unreadable in dark mode.** The primary buttons paired
  a `--dsw-alias-brand-primary` fill — which is near-white (`#f9fafb`) in dark
  mode — with a literal `#fff` label, so the text disappeared into the button.
  They now use the first-party pairing `--dsw-alias-label-primary` fill over
  `--dsw-alias-bg-layer-3` label; those two tokens swap together per theme, so
  the label stays legible in both.
- Status colours come from the `--dsw-alias-state-{success,warn,error}-*` tokens
  instead of hardcoded hex, so badges and hints survive a theme switch. The
  non-existent `--dsw-alias-label-error` token is no longer referenced.

### Changed

- Secondary buttons use the first-party ghost treatment: transparent fill, a
  `--dsw-alias-border-l2` outline and the secondary label colour.
- Disabled buttons use the first-party 40% opacity, down from 50%.
- CI: `actions/checkout` and `actions/setup-node` bumped to v6, which runs on the
  Node 24 runtime and clears the Node 20 deprecation annotations.

### Tests

- The client bundle suite grew from 6 to 10 cases. It now has deep-render
  helpers that expand function components the way React would, so nodes owned by
  child components — the credential fields' buttons — are reachable from a test.
  The new cases guard the theme regressions directly: primary buttons must use
  the paired tokens, no style may paint `--dsw-alias-brand-primary` behind a
  fixed colour, disabled buttons must sit at 0.4 opacity, and status colours must
  come from state tokens rather than literals.

## [0.2.1] — 2026-09-13

First public release. Earlier 0.1.x–0.2.x iterations were developed privately
inside a DSH workspace and are folded into this version.

### Added

- **PubMed tools** over the official NCBI E-utilities API:
  - `pubmed_search` — `esearch` → `esummary` → `efetch`, with field-tagged
    queries, `sort`, publication-date windows and `offset` paging.
  - `pubmed_paper` — full record for one PMID (abstract, MeSH, keywords,
    publication types, comment/reference lines).
  - `pubmed_related` — `elink` `pubmed_pubmed` neighbour ranking.
- **Google Scholar tools**:
  - `scholar_search` — SerpApi `google_scholar` engine, or direct HTML parsing
    of `scholar.google.com` when no key is configured.
  - `scholar_cite` — MLA/APA/Chicago/Harvard/Vancouver/BibTeX citations
    (SerpApi backend only).
- **Settings page** (Settings → Plugins → Literature Search) served by
  `/plugin/literature-search`: credential slots, backend selection, rate and
  result limits, and a one-click connectivity test for both backends.
- **Unified `paper` structure** shared by both backends (`lib/paper.js`),
  including the JSON output schema and text rendering.
- **Rate limiting and retries** (`lib/http.js`): a per-endpoint serial gate
  (350 ms without an NCBI key, 110 ms with one), timeouts, exponential backoff
  on 429/5xx that honours `Retry-After`, and a built-in Chrome user agent.
- **CLI** (`cli.mjs`) for validating retrieval without loading DSH.
- **Offline test suite** — 58 cases across MEDLINE parsing, Scholar
  parsing/paging, plugin and tool contracts, settings routes, the client bundle
  and config drift. No network, no test framework, stub `fetch`.
- **Live smoke tests** (`test/live-pubmed.mjs`, `test/live-scholar.mjs`) and a
  Scholar connectivity probe (`test/probe-scholar.mjs`). Unreachable upstreams
  are reported as `SKIP`, not `FAIL`.
- **Installation scripts** — `install.ps1`, `uninstall.ps1`, and
  `setup-dev-links.ps1` with `tools/extract-dev-deps.mjs` for dev-only
  runtime links.
- **API research notes** in [`docs/API-RESEARCH.md`](docs/API-RESEARCH.md).

### Notes

- Zero runtime dependencies: only the Node built-in `fetch`/`AbortSignal` and
  the `@deepseek-ai/*` peers that DSH itself provides.
- `scholar.google.com` has no official API. The HTML backend is best-effort and
  reports HTTP 429 / anti-bot pages as explicit errors rather than silently
  returning empty results.

[Unreleased]: https://github.com/Astervolans/dsh-literature-search/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.3.3
[0.3.2]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.3.2
[0.3.1]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.3.1
[0.3.0]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.3.0
[0.2.4]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.4
[0.2.3]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.3
[0.2.2]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.2
[0.2.1]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.1
