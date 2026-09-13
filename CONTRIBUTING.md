# Contributing

Thanks for taking the time to improve `dsh-literature-search`.

## Ways to help

- **Bug reports** — open an issue with the DSH version, Node version, the exact
  tool call, and the full error text.
- **New literature backends** — arXiv, Crossref, Semantic Scholar, Europe PMC
  and friends map cleanly onto the existing `paper` structure in
  `lib/paper.js`. Please add an offline parser suite alongside the client.
- **Parser fixtures** — captured upstream payloads under `test/fixtures/` are
  what keep the offline suite honest. Real-world samples with unusual shapes
  are especially welcome.
- **Documentation** — the README and `docs/API-RESEARCH.md` should stay accurate
  about upstream behaviour and limits.

## Development setup

Requires **Node `^22.19.0 || >=24.0.0`** and, on Windows, PowerShell 5.1+.

```powershell
git clone https://github.com/Astervolans/dsh-literature-search.git
cd dsh-literature-search
```

The offline suite imports two DSH runtime packages (`@deepseek-ai/dsh-tools`
and `@deepseek-ai/schemastery`). Pick whichever route matches your machine.

### Route A — from a local DSH installation (no network)

```powershell
powershell -ExecutionPolicy Bypass -File setup-dev-links.ps1
```

This extracts the runtime closure out of `resources/app.asar` with
`tools/extract-dev-deps.mjs` and junctions it into `node_modules/`. Pass
`-Asar <path>` if DSH Desktop is not at the default location, or `-DshHome`
for a non-default DSH home.

### Route B — from npm (used by CI)

```powershell
npm install --prefix .dev-deps --legacy-peer-deps
cmd /c mklink /J node_modules .dev-deps\node_modules   # Windows
# ln -s "$PWD/.dev-deps/node_modules" node_modules     # macOS / Linux
```

`.dev-deps/package.json` pins the DSH runtime versions used by CI.

> Both routes are dev-only. The plugin itself ships **zero runtime
> dependencies** and `install.ps1` deliberately excludes `node_modules/` and
> `.dev-deps/` when copying into a DSH profile.

## Running the tests

```powershell
node test/run-all.mjs
# or
npm test
```

The offline suite must stay green. It uses stub `fetch` and fake services — it
never touches the network, so it is safe to run repeatedly.

Live checks hit real upstreams and are opt-in:

```powershell
node test/live-pubmed.mjs      # eutils.ncbi.nlm.nih.gov
node test/live-scholar.mjs     # scholar.google.com
node test/probe-scholar.mjs    # connectivity diagnosis
```

A blocked, throttled or unreachable upstream is reported as `SKIP`. Only
"the page contained result blocks but we parsed zero papers" counts as failure.

## Project conventions

- **Every offline test you add must keep the whole run network-free.** Use the
  harness in `test/harness.mjs` to inject a stub `fetch`.
- **Tabs** for indentation in `.js`/`.mjs`, 2 spaces in `.json`/`.yml`/`.md`,
  4 spaces in `.ps1`. See `.editorconfig`.
- **LF line endings**, UTF-8, final newline. See `.gitattributes`.
- **No new runtime dependencies.** If you need something, prefer a small local
  helper over a package. The whole point of this plugin is that it drops into a
  DSH profile with no `npm install`.
- **Never commit credentials.** Keys belong in `$DSH_HOME/.credentials.yaml`
  (via the settings page) or in environment variables. `cordis.patch.yml` has
  `pubmedApiKey` / `scholarSerpApiKey` fields — leave them empty.
- **Keep the two config surfaces in sync.** `cordis.patch.yml`, the embedded
  row in `install.ps1` and the `Config` schema in `lib/index.js` are checked by
  the `config` suite. Adding a key means touching all three.
- **Keep the two READMEs in sync.** `README.md` is English and is what npm
  renders, so it is the primary one; `README.zh-CN.md` holds the Chinese
  original. A user-facing change belongs in both, and each file links to the
  other at the top. `docs/API-RESEARCH.md` is Chinese only — that is fine, it is
  a research record rather than the front page.
- **Document upstream limits you rely on** in `docs/API-RESEARCH.md`, with the
  evidence you gathered.

## Releasing

The plugin is published to npm as `dsh-literature-search`. Publishing is what
makes the 1024 Store list an install command for it — the store detects a
published manifest that declares `dsh.bundle`, so no catalog change is needed
after the first release.

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. Confirm the package contents: `npm pack --dry-run`. `package.json` and
   `cordis.patch.yml` **must** both be in the tarball — the latter is the
   `dsh.bundle.patch` the harness loads.
3. `npm publish`. `prepublishOnly` runs the offline suite first and aborts the
   publish if anything fails.
4. Tag and push: `git tag -a vX.Y.Z -m "..."` then `git push origin main --tags`.
5. Create the GitHub release from the same changelog section.

Note that npm does not allow republishing a version, so a mistake means
publishing the next patch rather than overwriting.

## Submitting a change

1. Fork the repository and branch off `main`.
2. Make the change, add or update tests, and run `node test/run-all.mjs`.
3. Keep the diff focused; unrelated reformatting makes review harder.
4. Update `CHANGELOG.md` under `## [Unreleased]`.
5. Open a pull request and fill in the template.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
