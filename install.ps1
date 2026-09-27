# dsh-literature-search install script (Windows PowerShell).
# Copies the plugin into a DSH profile's node_modules and merges the managed
# config row into that profile's cordis.patch.yml (idempotent).
#
# The package is published under the scoped npm name
# `@astervolans/dsh-literature-search`, so it lands in the profile at
# node_modules\@astervolans\dsh-literature-search — that is the layout pnpm
# produces for `dsh plugin --profile <p> add @astervolans/dsh-literature-search`,
# and the path the managed row's `name` must resolve from.
#
# The plugin has zero runtime dependencies: it uses the global fetch/AbortSignal
# APIs and resolves @deepseek-ai/* peers from $DshHome\profiles\node_modules,
# which DSH already provides. No npm install and no network access are needed.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Profile desktop]
param(
    [string]$Profile = "desktop",
    [string]$DshHome = "$env:USERPROFILE\.dsh"
)

$ErrorActionPreference = "Stop"

$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$Target = Join-Path $ProfileDir "node_modules\@astervolans\dsh-literature-search"
$PatchFile = Join-Path $ProfileDir "cordis.patch.yml"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $ProfileDir)) {
    Write-Error "profile directory not found: $ProfileDir"
    exit 1
}

# 1. copy the plugin package into the profile
#    node_modules and .dev-deps are excluded on purpose: the plugin has zero
#    runtime dependencies (DSH resolves @deepseek-ai/* from its own runtime),
#    and the dev-only junctions the test suite needs must never be copied into
#    the profile. /XJ keeps robocopy off junctions.
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
Write-Host "==> copying plugin to $Target"
robocopy $PluginRoot $Target /E /XD .git node_modules .dev-deps /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

# 2. merge the bundle row into the profile patch layer (idempotent)
$PatchContent = [System.IO.File]::ReadAllText($PatchFile)
if ($PatchContent -match "# ---- dsh-literature-search \(managed by") {
    # The row is already managed. Before 0.3.0 it pinned the *unscoped* module
    # specifier, which the cordis loader resolves from the profile directory
    # where only the scoped package now exists — leaving it would make
    # `dsh web` abort at startup with `Cannot find package`. Rewrite just that
    # value; the row id, the settings namespace and the config stay untouched.
    $upgraded = [System.Text.RegularExpressions.Regex]::Replace(
        $PatchContent,
        '(?m)^([ \t]*name:[ \t]*)dsh-literature-search[ \t]*$',
        '$1"@astervolans/dsh-literature-search"')
    if ($upgraded -ne $PatchContent) {
        [System.IO.File]::WriteAllText($PatchFile, $upgraded, $Utf8NoBom)
        Write-Host "==> rewrote the managed row's module specifier to @astervolans/dsh-literature-search"
    } else {
        Write-Host "==> cordis.patch.yml already carries the managed literature-search row; leaving it untouched"
    }
} else {
    $block = @"

# ---- dsh-literature-search (managed by plugins\dsh-literature-search\install.ps1) ----
- insert:
    - id: literature-search
      name: "@astervolans/dsh-literature-search"
      config:
        enabled: true
        pubmedEnabled: true
        pubmedBaseUrl: https://eutils.ncbi.nlm.nih.gov/entrez/eutils
        pubmedTool: dsh-literature-search
        pubmedEmail: ''
        pubmedApiKeyEnv: NCBI_API_KEY
        pubmedApiKey: ''
        pubmedRateLimitMs: 0
        scholarEnabled: true
        scholarProvider: auto
        scholarBaseUrl: https://scholar.google.com
        scholarSerpApiBaseUrl: https://serpapi.com
        scholarSerpApiKeyEnv: SERPAPI_API_KEY
        scholarSerpApiKey: ''
        scholarHl: en
        scholarRateLimitMs: 0
        defaultMaxResults: 10
        maxResultsCap: 50
        abstractMaxChars: 600
        requestTimeoutMs: 30000
        maxRetries: 3
        retryBackoffMs: 1000
        toolTimeoutMs: 120000
        userAgent: ''
        promptGuidance: true
        promptOrder: 155
"@
    $trimmed = $PatchContent.TrimEnd()
    if ($trimmed.EndsWith("[]")) {
        $newContent = $trimmed.Substring(0, $trimmed.Length - 2) + $block + "`n"
    } else {
        $newContent = $trimmed + "`n" + $block + "`n"
    }
    [System.IO.File]::WriteAllText($PatchFile, $newContent, $Utf8NoBom)
    Write-Host "==> patched $PatchFile (literature-search row added)"
}

Write-Host ""
Write-Host "dsh-literature-search installed into profile '$Profile'."
Write-Host "Next: restart DSH (desktop app or 'dsh web') so the profile patch layer is loaded."
Write-Host "Optional: set NCBI_API_KEY (raises PubMed to 10 req/s) and SERPAPI_API_KEY (Google Scholar)."
Write-Host "Verify without restarting: node cli.mjs pubmed `"CRISPR base editing`" --max 3"
