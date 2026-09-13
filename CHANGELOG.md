# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Astervolans/dsh-literature-search/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.4
[0.2.3]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.3
[0.2.2]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.2
[0.2.1]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.1
