# Pull request

## What does this change?

<!-- One or two sentences. Link the issue it closes, if any: "Closes #12". -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] New literature backend
- [ ] Documentation
- [ ] Test / tooling only

## Checklist

- [ ] `node test/run-all.mjs` passes locally and stays **network-free**.
- [ ] New behaviour is covered by an offline test (stub `fetch`, no live calls).
- [ ] No new **runtime** dependency — the plugin still installs with no `npm install`.
- [ ] No credentials, tokens or personal data in the diff.
- [ ] If a `Config` key changed: `lib/index.js`, `cordis.patch.yml` and the
      embedded row in `install.ps1` are all in sync.
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`.
- [ ] Upstream limits I rely on are written down in `docs/API-RESEARCH.md`.

## Backend notes

<!-- Skip if not relevant. -->

- Tool(s) affected:
- Upstream endpoint(s):
- Rate limit / quota behaviour:
- How failures surface to the model (empty result vs. explicit error):

## Verification

<!--
  Paste the command you ran and its result. Examples:

    node test/run-all.mjs                     -> ALL PASSED
    node cli.mjs pubmed "base editing" --max 3 -> 3 papers
-->
