# Dev-only helper: make the DSH packages this plugin imports resolvable from
# the project, so `node test/run-all.mjs` runs without a pnpm install.
#
# DSH Desktop ships its runtime inside resources/app.asar, and the profile's
# shared node_modules layout changes between releases, so the primary route is
# to extract the runtime closure out of the archive with
# tools/extract-dev-deps.mjs. If that archive is missing, a legacy
# profiles\node_modules layout is used instead.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup-dev-links.ps1 [-DshHome <dir>] [-Asar <path>]
param(
    [string]$DshHome = "$env:USERPROFILE\.dsh",
    [string]$Asar = "D:\DSH Desktop\resources\app.asar"
)

$ErrorActionPreference = "Stop"

$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DevDeps = Join-Path $PluginRoot ".dev-deps"
$LinkRoot = Join-Path $PluginRoot "node_modules"
$LegacyRoot = Join-Path $DshHome "profiles\node_modules"

$source = $null

if (Test-Path $Asar) {
    Write-Host "==> extracting the runtime closure from $Asar"
    Push-Location $PluginRoot
    try {
        & node "tools/extract-dev-deps.mjs" --asar $Asar --out $DevDeps
        if ($LASTEXITCODE -ne 0) { throw "extract-dev-deps failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    $source = Join-Path $DevDeps "node_modules"
} elseif (Test-Path (Join-Path $LegacyRoot "@deepseek-ai\dsh-tools")) {
    Write-Host "==> app.asar not found; using the legacy profile layout at $LegacyRoot"
    $source = $LegacyRoot
} else {
    Write-Error "neither $Asar nor $LegacyRoot provides @deepseek-ai/dsh-tools"
    exit 1
}

if (-not (Test-Path (Join-Path $source "@deepseek-ai\dsh-tools"))) {
    Write-Error "@deepseek-ai/dsh-tools missing under $source"
    exit 1
}

if (Test-Path $LinkRoot) {
    Write-Host "==> clearing $LinkRoot"
    Get-ChildItem $LinkRoot -Force | ForEach-Object {
        if ($_.LinkType) { cmd /c rmdir "$($_.FullName)" | Out-Null }
        else { Remove-Item $_.FullName -Recurse -Force }
    }
} else {
    New-Item -ItemType Directory -Force -Path $LinkRoot | Out-Null
}

foreach ($package in @("@deepseek-ai", "yaml")) {
    $target = Join-Path $source $package
    if (-not (Test-Path $target)) {
        Write-Warning "not present, skipping: $target"
        continue
    }
    cmd /c mklink /J "$LinkRoot\$package" "$target" | Out-Null
    Write-Host "==> linked $package -> $target"
}

Write-Host ""
Write-Host "Dev links ready. Run: node test/run-all.mjs"
