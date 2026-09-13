# dsh-literature-search uninstall script (Windows PowerShell).
# Removes the copied plugin package and the managed config row from a profile.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Profile desktop]
param(
    [string]$Profile = "desktop",
    [string]$DshHome = "$env:USERPROFILE\.dsh"
)

$ErrorActionPreference = "Stop"

$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$Target = Join-Path $ProfileDir "node_modules\dsh-literature-search"
$PatchFile = Join-Path $ProfileDir "cordis.patch.yml"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (Test-Path $Target) {
    Remove-Item -Recurse -Force $Target
    Write-Host "==> removed $Target"
} else {
    Write-Host "==> plugin copy not present at $Target"
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
