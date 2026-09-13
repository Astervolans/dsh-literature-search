# dsh-literature-search

**English** · [中文](README.zh-CN.md)

[![CI](https://github.com/Astervolans/dsh-literature-search/actions/workflows/ci.yml/badge.svg)](https://github.com/Astervolans/dsh-literature-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-literature-search.svg)](https://www.npmjs.com/package/dsh-literature-search)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)

A DeepSeek Harness (dsh) plugin that searches the literature through the
**official PubMed NCBI E-utilities API** and **Google Scholar**, and returns
both backends as one shared `paper` shape.

- **PubMed uses the official API**: `esearch` (find PMIDs) → `esummary`
  (metadata) → `efetch` (abstract / MeSH / keywords) → `elink` (related work).
  Free, no key required, documented, and stable over the long run.
- **Google Scholar has no official API**: with a SerpApi key it uses SerpApi's
  `google_scholar` engine; without one it parses `scholar.google.com` HTML
  directly. Google throttles and blocks that, so the plugin **fails loudly**
  instead of quietly returning an empty result.
- **Zero runtime dependencies**: only the Node built-in `fetch` /
  `AbortSignal`. The `@deepseek-ai/*` packages come from the DSH runtime, so
  there is nothing to build and nothing extra to install.
- **Settings page**: a dedicated card under **Settings → Plugins → Literature
  Search** for NCBI / SerpApi keys, the Scholar backend, rate and result
  limits, and a one-click connectivity test.

> The API research behind these choices — parameters, rate limits, response
> shapes, measured evidence and rejected alternatives — is written up in
> [`docs/API-RESEARCH.md`](docs/API-RESEARCH.md) (Chinese).

## Tools

| Tool | Upstream | What it does |
| --- | --- | --- |
| `pubmed_search` | E-utilities `esearch` + `esummary` + `efetch` | Field-tagged queries with `sort`, publication-date windows and `offset` paging. Returns PMID, title, authors, journal, volume/issue/pages, DOI, PMC id, abstract, MeSH and keywords. |
| `pubmed_paper` | `efetch` + `esummary` | The full record for one PMID, including abstract, MeSH, keywords, publication types and comment/reference lines. |
| `pubmed_related` | `elink` `pubmed_pubmed` | Ranks articles related to a given one using NCBI's related-article algorithm. |
| `scholar_search` | SerpApi / HTML | Google Scholar search: title, authors, venue, year, cited-by count, snippet and PDF link. Supports a year window and paging. |
| `scholar_cite` | SerpApi `google_scholar_cite` | Ready-to-paste citations in MLA, APA, Chicago, Harvard, Vancouver and BibTeX (SerpApi backend only). |

All tool names are distinct from the existing `dsh-ai4scholar` plugin
(`search_pubmed` / `search_google_scholar`), so the two can coexist.

## Install

### From npm (recommended)

```bash
dsh plugin --profile desktop add dsh-literature-search
```

`dsh plugin` forwards to pnpm inside the profile directory and then reconciles
the profile's bundle list: any installed dependency whose manifest declares
`dsh.bundle` joins the layer stack automatically. Replace `desktop` with `web`
if you run the `dsh web` CLI. Restart DSH afterwards so the new tools load.

Remove it with:

```bash
dsh plugin --profile desktop remove dsh-literature-search
```

### From a source checkout (offline)

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop
```

- `-Profile` is the target profile (`desktop` for the desktop app, `web` for
  the `dsh web` CLI).
- The script does two things: it copies the plugin into
  `$DSH_HOME\profiles\<profile>\node_modules\dsh-literature-search`, and it
  merges the `literature-search` config row into that profile's
  `cordis.patch.yml` (idempotent — safe to re-run).
- Restart DSH (desktop app or `dsh web`) to load the new tools.
- To remove it:
  `powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Profile desktop`.

You can also skip the profile entirely and verify retrieval first with the CLI:

```powershell
node cli.mjs pubmed "CRISPR base editing" --max 3
node cli.mjs paper 33301246
node cli.mjs scholar "base editing" --max 5   # HTML backend without a key; may be blocked
```

## Credentials (optional)

| Environment variable / credential | Effect | If unset |
| --- | --- | --- |
| `NCBI_API_KEY` | Raises the E-utilities quota from 3 to 10 requests/second | Still works; the plugin throttles itself to 350 ms per request |
| `SERPAPI_API_KEY` | Routes Google Scholar through SerpApi (stable, includes cited-by counts and citation formats) | Falls back to HTML scraping, which Google may answer with HTTP 429 |
| `NCBI_EMAIL` | CLI only; sent as the E-utilities `email` parameter | NCBI recommends setting it so they can contact you about unusual traffic |

Three ways to configure them. The plugin resolves in this order: inline config
→ credential service → environment variable.

1. Environment variables in the process that starts DSH.
2. `$DSH_HOME\.credentials.yaml` (the DSH credential service), written by the
   settings page, which stores `NCBI_API_KEY` / `SERPAPI_API_KEY`.
3. Inline in `cordis.patch.yml` via `pubmedApiKey` / `scholarSerpApiKey` —
   **not recommended**, because it is easy to commit by accident.

## Settings page

The client plugin (`lib/client.js`) registers a tab in the settings panel; the
server side exposes `/plugin/literature-search` to back it:

| Route | Purpose |
| --- | --- |
| `GET /plugin/literature-search/config` | Returns the (redacted) settings namespace, the revision, and status facts |
| `POST /plugin/literature-search/config` | Patch write fenced by `expectedRevision`; a conflict returns 409 |
| `POST /plugin/literature-search/credential` | Writes or clears a key for a `slot` (`pubmed` / `scholar`) |
| `POST /plugin/literature-search/test` | Actually runs a PubMed esearch and a Scholar search, and reports latency and outcome |

What the page gives you:

- **Credentials** — the NCBI and SerpApi keys are written through the
  **credential service** into `$DSH_HOME/.credentials.yaml`, never into the
  settings document. The page shows the source (`environment` = read-only,
  `saved` = editable) and the configuration state.
- **Backend** — `scholarProvider` is a three-way choice (auto / serpapi /
  html) and takes effect **immediately** on save; the client cache is
  invalidated and rebuilt.
- **Rate and results** — PubMed/Scholar request intervals, default and maximum
  result counts, abstract length, timeout and retries all apply immediately.
- **Connectivity test** — probes PubMed and Google Scholar separately and
  explains failures, including a "blocked or throttled → configure SerpApi"
  hint.
- **Needs a restart** — `enabled`, `pubmedEnabled`, `scholarEnabled`,
  `promptGuidance` and `promptOrder` are registration-time switches; changing
  them requires restarting DSH. The page says so.

Implementation notes: `lib/web.js` owns the routes and fact collection;
`lib/client.js` is a hand-written module-loader bundle
(`window.__ModuleLoader__.load`, with `require("react")` resolved by the DSH
client runtime). **There is no build step.**

### How keys are stored, and how their state is decided

Each key slot is judged by **two independent probes**, and a non-sensitive
diagnostic line (`ref=` / `describe=` / `resolve=` / `error=`) is printed
under the badge:

1. **The credential service** (`ctx.credentials`, writing
   `$DSH_HOME/.credentials.yaml`) — preferred;
2. **The in-settings key fields** (`pubmedApiKey` / `scholarSerpApiKey`,
   marked `role('secret')` and redacted on read) — used automatically when the
   current composition has **no** credential service. `resolveSecret` prefers
   it too.

So whether or not a credential service is present, a key lands somewhere the
plugin genuinely reads. If the two probes disagree — `describe` says
unconfigured while `resolve` returns a value — the page shows "configured" and
keeps both raw conclusions in the diagnostic line.

The server also writes the verdict, **without any key values**, to:

```
$DSH_HOME/.dsh-literature-search/diagnostics.json
```

`GET /config`, `POST /credential` and `POST /test` each refresh it. It holds
the raw `describe`/`resolve` conclusions, error text, `DSH_HOME` and `cwd`, and
booleans for whether a same-named environment variable exists. If you saved a
key and the page still says unconfigured, read this file first.

Both the server and the tool layer read `settings` / `credentials` from the
**injected context** (`ctx.inject(['credentials'], …)`) rather than
`ctx.get('credentials')` — the latter can miss a sibling plugin's service in
some compositions, which is the usual reason a key "saves but never resolves".

## Configuration

The `literature-search` row in `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether the plugin registers its tools |
| `pubmedEnabled` | `true` | Whether the three `pubmed_*` tools are registered |
| `pubmedBaseUrl` | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | E-utilities root |
| `pubmedTool` / `pubmedEmail` | `dsh-literature-search` / empty | The `tool` / `email` parameters sent on every request (required by NCBI's usage policy) |
| `pubmedApiKeyEnv` / `pubmedApiKey` | `NCBI_API_KEY` / empty | Key reference / inline key |
| `pubmedRateLimitMs` | `0` | Minimum interval between requests; 0 = 350 ms without a key, 110 ms with one |
| `scholarEnabled` | `true` | Whether the two `scholar_*` tools are registered |
| `scholarProvider` | `auto` | `auto` (SerpApi when a key exists, else HTML) / `serpapi` / `html` |
| `scholarBaseUrl` / `scholarSerpApiBaseUrl` | Official Google / SerpApi URLs | Can point at a self-hosted proxy |
| `scholarSerpApiKeyEnv` / `scholarSerpApiKey` | `SERPAPI_API_KEY` / empty | Key reference / inline key |
| `scholarHl` | `en` | Google Scholar interface language |
| `scholarRateLimitMs` | `0` | 0 = 2500 ms for HTML, 250 ms for SerpApi |
| `defaultMaxResults` / `maxResultsCap` | `10` / `50` | Count when the model does not specify / the maximum requestable |
| `abstractMaxChars` | `600` | Per-paper abstract or snippet limit; 0 = omit abstracts |
| `requestTimeoutMs` / `maxRetries` / `retryBackoffMs` | `30000` / `3` / `1000` | Per-request timeout, retry count and backoff base (429/5xx are retried, honouring `Retry-After`) |
| `toolTimeoutMs` | `120000` | Budget for one tool call |
| `userAgent` | empty (built-in Chrome UA) | Overrides the default UA |
| `promptGuidance` / `promptOrder` | `true` / `155` | Whether the system-prompt paragraph is registered, and its order |

## Usage examples

On the model side, plain language is enough:

> Use pubmed_search for "base editing" reviews published after 2020, take 5,
> then use pubmed_related on the first one to find 5 related papers.

> Use scholar_search to find the 10 most-cited "CRISPR base editing" papers,
> then pass the first resultId to scholar_cite for BibTeX.

Example output (`pubmed_paper 33301246`):

```
PubMed record: Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.

Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.
   2020 · The New England journal of medicine · vol 383 · no 27 · pp 2603-2615
   Polack, Fernando P, Thomas, Stephen J, Kitchin, Nicholas et al. (29 authors)
   DOI: 10.1056/NEJMoa2034577 · PMID: 33301246 · PMC: PMC7745181
   https://pubmed.ncbi.nlm.nih.gov/33301246/
   Types: Clinical Trial, Phase III, Journal Article, Randomized Controlled Trial
   MeSH: BNT162 Vaccine, COVID-19, SARS-CoV-2, ...
   Abstract: BACKGROUND: ...
```

## Testing

The offline suite needs two DSH runtime packages (`@deepseek-ai/dsh-tools` and
`@deepseek-ai/schemastery`). Prepare them either way:

```powershell
# Route A: extract them from a local DSH install (no network)
powershell -ExecutionPolicy Bypass -File setup-dev-links.ps1   # first run only

# Route B: install them from npm (what CI uses; works without DSH installed)
node tools/fetch-dev-deps.mjs

# Offline: parsers + plugin contract + settings routes + client bundle + config drift
node test/run-all.mjs

# Live: real upstreams, needs access to the corresponding domains
node test/live-pubmed.mjs      # eutils.ncbi.nlm.nih.gov
node test/live-scholar.mjs     # scholar.google.com (a refusal is recorded as SKIP)
node test/probe-scholar.mjs    # connectivity diagnosis: status / result blocks / anti-bot
```

- `setup-dev-links.ps1` calls `tools/extract-dev-deps.mjs`, which extracts just
  the DSH runtime closure the tests need (`@deepseek-ai/dsh-tools`,
  `schemastery`, `yaml` and their transitive deps) out of
  `D:\DSH Desktop\resources\app.asar` into `.dev-deps/`, then junctions it into
  `node_modules/`. DSH upgrades and profile layout changes do not affect it.
  **The plugin itself has zero npm dependencies**, and neither `.dev-deps/` nor
  `node_modules/` is ever copied into a profile.
- `tools/fetch-dev-deps.mjs` takes the other route: it installs the same
  packages from npm at the versions pinned in `.dev-deps/package.json`, then
  symlinks them into `node_modules/`. This is what CI uses, on machines with no
  DSH installed (`.github/workflows/ci.yml` runs the full offline suite on
  Ubuntu and Windows across Node 22 and 24).
- The offline suite is **62 cases**: MEDLINE parsing 7, Scholar parsing/paging
  6, plugin and tools 21 (including "a settings write switches the Scholar
  backend live", "a credential written through the seam is picked up without a
  restart" and live result limits), settings routes 14, client bundle 10 and
  config drift 4. All of them use stub `fetch` and fake services — no network.
- The client bundle suite drives a stub `window.__ModuleLoader__` plus a minimal
  React shim to actually execute and walk the render tree, which catches typos
  and null dereferences in the settings page without a browser. It has already
  paid for itself by finding a `state.drafts` null crash. Since 0.2.2 it expands
  function components for a deep render, so nodes owned by child components —
  such as the credential fields' buttons — are reachable from a test, and it
  guards the theme regressions directly: primary buttons must use paired
  tokens, and `--dsw-alias-brand-primary` must never be a fill colour.
- The live tests record **upstream unavailability** (no egress, DNS, timeouts,
  HTTP 429, anti-bot pages) as SKIP rather than FAIL, because that is an
  environment or policy problem. Only "the page contained result blocks but we
  parsed zero papers" counts as a failure. Measured here: the Google Scholar
  HTML backend passed 5/5; PubMed egress from this machine was intermittent and
  prints SKIP with a reason when it fails.

## Repository layout

```
dsh-literature-search/
├── lib/
│   ├── index.js     # Plugin entry: Config / apply / runtime / settings namespace / prompt paragraph
│   ├── web.js       # /plugin/literature-search routes: config, credentials, connectivity test
│   ├── client.js    # Settings-page client plugin (window.__ModuleLoader__, no build step)
│   ├── http.js      # Rate gate, timeout, retries, Retry-After, JSON/text decoding
│   ├── paper.js     # Shared paper shape, output schema, rendering
│   ├── medline.js   # MEDLINE text parsing (efetch rettype=medline)
│   ├── pubmed.js    # E-utilities client + the three pubmed_* tools
│   └── scholar.js   # Google Scholar (SerpApi / HTML) + the two scholar_* tools
├── tools/
│   ├── extract-dev-deps.mjs   # Extract the test runtime closure from app.asar
│   └── fetch-dev-deps.mjs     # Install the same packages from npm (CI / no DSH)
├── test/            # Offline suites (incl. settings routes and client bundle) + live smoke + fixtures
├── docs/API-RESEARCH.md
├── .github/         # CI workflow + issue / PR templates
├── .dev-deps/package.json   # Pins the DSH runtime versions used by the offline suite (the only tracked file there)
├── cli.mjs          # Command-line verification that does not load DSH
├── install.ps1 / uninstall.ps1 / setup-dev-links.ps1
├── cordis.patch.yml
├── LICENSE / CHANGELOG.md / CONTRIBUTING.md / SECURITY.md
└── package.json
```

## Known limitations

- **PubMed date filtering uses the print publication date (`pdat`)**: the
  `esummary.pubdate` of an ahead-of-print record can show a later year. That is
  PubMed's own behaviour, not a plugin bug.
- **Google Scholar has no official API**: the HTML backend is intermittent (the
  same machine can return 200, then 429, then fail to connect). The plugin
  raises a readable error and names the alternatives. Use a SerpApi key if you
  need reliability.
- **PubMed abstracts may be copyright-protected**: NCBI's disclaimer asks users
  to respect the rights holders' terms. For large-scale mining, download a local
  copy of PubMed instead.
- `scholar_cite` only works on the SerpApi backend; the HTML endpoint has no
  citation-format interface.

## When scholar.google.com is unreachable

On a network where `scholar.google.com` (and the `.com.hk` / `.co.jp` / `.de`
mirrors) is blocked, requests fail with `UND_ERR_CONNECT_TIMEOUT`, while
`serpapi.com` and `eutils.ncbi.nlm.nih.gov` are fine. The quickest check is the
**"Test Google Scholar"** button on the settings page; from the command line
there is a diagnostic script:

```powershell
node test/probe-scholar.mjs
```

- `resultBlocks > 0` — the page was fetched, so the HTML backend works
  (`scholarBaseUrl` can point at any reachable mirror).
- `blocked=true` — Google served an anti-bot page; slow down or switch to
  SerpApi.
- `ERR UND_ERR_CONNECT_TIMEOUT` — the network layer is blocked; pick one of the
  two options below.

**Option A: configure SerpApi (recommended, reliable).**
Paste the SerpApi key into the "Google Scholar" section of the settings page and
save (it goes to `$DSH_HOME/.credentials.yaml`), or set `SERPAPI_API_KEY` in the
environment that starts DSH. With `scholarProvider=auto` it switches to SerpApi
automatically.

**Option B: go through a local proxy.**
If you run a proxy locally (Clash defaults to `127.0.0.1:7897`), start DSH with
Node 24's environment-variable proxy support:

```powershell
set NODE_USE_ENV_PROXY=1
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
"D:\DSH Desktop\DSH Desktop.exe"
```

Note that `NODE_USE_ENV_PROXY` requires Node 24 and the variables must be set on
**the DSH process itself**, because the plugin's `fetch` inherits them. If the
proxy client is not running (`ProxyEnable=0` and nothing listening on the port),
this option does nothing.

PubMed is unaffected: `eutils.ncbi.nlm.nih.gov` is directly reachable on the
same network.

## Contributing

Issues and pull requests are welcome. Development setup, test commands and code
conventions are in [`CONTRIBUTING.md`](CONTRIBUTING.md); the change history is
in [`CHANGELOG.md`](CHANGELOG.md).

Please do not open a public issue for a security problem — use the private
channel described in [`SECURITY.md`](SECURITY.md). This plugin handles NCBI and
SerpApi credentials, so anything that can leak a key is treated as a security
issue.

## License

[MIT](LICENSE)
