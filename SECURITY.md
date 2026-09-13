# Security Policy

## Supported versions

The latest release on the `main` branch is supported. This plugin is developed
against a moving DSH runtime, so fixes land on `main` rather than on back
branches.

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅        |
| < 0.2   | ❌        |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: go to the repository's **Security** tab and
choose **Report a vulnerability**. If that is unavailable, open a minimal issue
asking for a private channel — without any details — and a maintainer will
follow up.

Please include:

- what the issue is and where it lives (file, route, or tool),
- how to reproduce it,
- the impact you believe it has,
- any suggested fix.

You can expect an acknowledgement within a few days. This is a volunteer
project, so please allow reasonable time before disclosing publicly.

## Handling of credentials

This plugin reads two optional API keys — an NCBI E-utilities key and a SerpApi
key — so credential handling is the main security surface. The intended design:

- **Keys are stored outside the settings document.** Writing a key through the
  settings page goes to DSH's credential service
  (`$DSH_HOME/.credentials.yaml`), not into `settings`. The settings page only
  ever displays a redacted descriptor.
- **Resolution order is** inline config → credential service → environment
  variable. `pubmedApiKeyEnv` / `scholarSerpApiKeyEnv` name the environment
  variables to read; their values are never logged.
- **The diagnostic file is key-free.** The settings page writes
  `$DSH_HOME/.dsh-literature-search/diagnostics.json`, which records *whether* a
  key resolved and from where — including booleans for the environment
  variables — but never a key value.
- **Never put a key in `cordis.patch.yml`.** The `pubmedApiKey` and
  `scholarSerpApiKey` fields exist as an escape hatch and are easy to commit by
  accident. Use the settings page or environment variables instead.

If you find a path where a key value can leak into a log, a rendered page, a
tool result, or a file this plugin writes, that is a security bug — please
report it privately.

## Outbound network behaviour

The plugin talks only to the endpoints configured in `cordis.patch.yml`:

| Default endpoint | Purpose |
| --- | --- |
| `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | PubMed `esearch`/`esummary`/`efetch`/`elink` |
| `https://scholar.google.com` | Google Scholar HTML fallback |
| `https://serpapi.com` | Google Scholar via SerpApi, when a key is set |

`pubmedBaseUrl`, `scholarBaseUrl` and `scholarSerpApiBaseUrl` are configurable,
so a deployment can point them at a proxy or a mirror. Be aware that doing so
sends your queries — and any configured API key — to whatever host you name.

Requests carry a `tool` identifier and, if configured, an `email` parameter, as
NCBI's usage policy requires. No telemetry is collected and nothing is sent
anywhere else.

## Scope

The offline test suite never touches the network: it runs against stub `fetch`
implementations and captured fixtures. If you find a test that makes a real
request, that is a bug worth reporting too.
