# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Astervolans/dsh-literature-search/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Astervolans/dsh-literature-search/releases/tag/v0.2.1
