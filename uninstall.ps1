# dsh-literature-search uninstall script (Windows PowerShell).
# Removes the copied plugin package and the managed config row from a profile.
#
# The package lives at node_modules\@astervolans\dsh-literature-search (scoped
# npm name). The pre-0.3.0 unscoped copy at node_modules\dsh-literature-search
# is removed too, so an install that predates the rename is fully cleaned up.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Profile desktop]
param(
    [string]$Profile = "desktop",
    [string]$DshHome = "$env:USERPROFILE\.dsh"
)

$ErrorActionPreference = "Stop"

$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$ScopeDir = Join-Path $ProfileDir "node_modules\@astervolans"
$Target = Join-Path $ScopeDir "dsh-literature-search"
$Legacy = Join-Path $ProfileDir "node_modules\dsh-literature-search"
$PatchFile = Join-Path $ProfileDir "cordis.patch.yml"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

foreach ($copy in @($Target, $Legacy)) {
    if (Test-Path $copy) {
        Remove-Item -Recurse -Force $copy
        Write-Host "==> removed $copy"
    } else {
        Write-Host "==> plugin copy not present at $copy"
    }
}

# Prune the scope directory when this was the only @astervolans package in it.
if ((Test-Path $ScopeDir) -and -not (Get-ChildItem -Force $ScopeDir)) {
    Remove-Item -Force $ScopeDir
    Write-Host "==> removed empty $ScopeDir"
}

if (Test-Path $PatchFile) {
    $content = [System.IO.File]::ReadAllText($PatchFile)
    $pattern = "(?s)\r?\n# ---- dsh-literature-search \(managed by .*?(?=\r?\n# ----|\r?\n- id:|\z)"
    if ($content -match $pattern) {
        $content = [System.Text.RegularExpressions.Regex]::Replace($content, $pattern, "")
        [System.IO.File]::WriteAllText($PatchFile, $content.TrimEnd() + "`n", $Utf8NoBom)
        Write-Host "==> removed the managed literature-search row from $PatchFile"
    } else {
        Write-Host "==> no managed literature-search row found in $PatchFile"
    }
}

Write-Host "Restart DSH to unload the tools."
