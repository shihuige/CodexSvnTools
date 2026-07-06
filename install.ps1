param(
    [string]$PluginRoot = $PSScriptRoot,
    [switch]$Reinstall
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw "codex command not found. Install Codex first, then run this script again."
}

$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$ManifestPath = Join-Path $PluginRoot ".codex-plugin\plugin.json"
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "Not a Codex plugin folder: $PluginRoot"
}

$PluginName = (Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json).name
if (-not $PluginName) {
    throw "Missing plugin name in $ManifestPath"
}

$addOutput = & codex plugin marketplace add $PluginRoot --json 2>&1
if ($LASTEXITCODE -ne 0 -and (($addOutput -join "`n") -notmatch "already|exists")) {
    throw ($addOutput -join "`n")
}

$Marketplace = $null
try {
    $json = $addOutput -join "`n" | ConvertFrom-Json
    if ($json.name) {
        $Marketplace = [string]$json.name
    } elseif ($json.marketplace -and $json.marketplace.name) {
        $Marketplace = [string]$json.marketplace.name
    } elseif ($json.marketplace_name) {
        $Marketplace = [string]$json.marketplace_name
    } elseif ($json.marketplaceName) {
        $Marketplace = [string]$json.marketplaceName
    }
} catch {
}

if (-not $Marketplace) {
    $list = & codex plugin marketplace list
    foreach ($line in $list) {
        if ($line -match "^(\S+)\s+(.+)$") {
            $root = $Matches[2].Trim()
            if ((Test-Path -LiteralPath $root) -and (Resolve-Path -LiteralPath $root).Path -eq $PluginRoot) {
                $Marketplace = $Matches[1]
                break
            }
        }
    }
}

if (-not $Marketplace) {
    $Marketplace = Split-Path -Leaf $PluginRoot
}

$Selector = "$PluginName@$Marketplace"
if ($Reinstall) {
    & codex plugin remove $Selector 2>$null
}

& codex plugin add $Selector
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install $Selector"
}

Write-Host "Installed $Selector"
