$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ToolsRoot = Join-Path $RepoRoot ".tools"
$ToolsBin = Join-Path $ToolsRoot "bin"

$PortableNodeDir = Join-Path $ToolsRoot "node-portable"
$RustupRoot = Join-Path $ToolsRoot "rustup"
$CargoHome = Join-Path $RustupRoot "cargo"
$RustupHome = Join-Path $RustupRoot "rustup-home"
$PlaywrightBrowsers = Join-Path $ToolsRoot "playwright-browsers"
$NpmCache = Join-Path $ToolsRoot "npm-cache"
$GitBin = "C:\Program Files\Git\bin"
$SolanaDir = Get-ChildItem $ToolsRoot -Filter "solana-v*" -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  Select-Object -First 1
$SolanaBin = if ($SolanaDir) { Join-Path $SolanaDir.FullName "solana-release\bin" } else { $null }

$paths = @()
if (Test-Path $ToolsBin) { $paths += $ToolsBin }
if (Test-Path $PortableNodeDir) { $paths += $PortableNodeDir }
if (Test-Path (Join-Path $CargoHome "bin")) { $paths += (Join-Path $CargoHome "bin") }
if ($SolanaBin -and (Test-Path $SolanaBin)) { $paths += $SolanaBin }
if (Test-Path $GitBin) { $paths += $GitBin }

if ($paths.Count -gt 0) {
  $env:Path = ($paths -join ";") + ";" + $env:Path
}

$env:DNA_TOOLS_ROOT = $ToolsRoot
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:PLAYWRIGHT_BROWSERS_PATH = $PlaywrightBrowsers
$env:npm_config_cache = $NpmCache

Write-Output "Tools root: $ToolsRoot"
Write-Output "PATH prefixed with: $($paths -join ', ')"

foreach ($command in @(
  @{ Name = "node"; Args = @("-v") },
  @{ Name = "npm"; Args = @("-v") },
  @{ Name = "npx"; Args = @("-v") },
  @{ Name = "cargo"; Args = @("-V") },
  @{ Name = "rustc"; Args = @("-V") },
  @{ Name = "solana"; Args = @("--version") },
  @{ Name = "solana-keygen"; Args = @("--version") }
)) {
  $resolved = Get-Command $command.Name -ErrorAction SilentlyContinue
  if ($resolved) {
    & $resolved.Source @($command.Args)
  }
}
