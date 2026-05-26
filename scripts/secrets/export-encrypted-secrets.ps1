param(
  [string]$OutputDir = ".local-secrets-backups"
)

$ErrorActionPreference = "Stop"

function Convert-SecureStringToPlainText {
  param([System.Security.SecureString]$SecureString)
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Invoke-OpenSslWithPassphrase {
  param(
    [string[]]$Arguments,
    [string]$Passphrase
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "openssl"
  foreach ($argument in $Arguments) {
    [void]$psi.ArgumentList.Add($argument)
  }
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false

  $process = [System.Diagnostics.Process]::Start($psi)
  $process.StandardInput.WriteLine($Passphrase)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0) {
    throw "openssl failed with exit code $($process.ExitCode): $stderr $stdout"
  }
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
  throw "openssl is required. Install OpenSSL or add it to PATH before exporting secrets."
}

$secretPaths = @(
  "x402/labs/polymarket-phase0/.env.local",
  "x402/test-mainnet/keys/mainnet/ALL_KEYS.json",
  "x402/test-mainnet/keys/mainnet/deployer.json",
  "x402/test-mainnet/keys/mainnet/runtime.env",
  "x402/test-mainnet/keys/devnet/ALL_KEYS.json",
  "x402/test-mainnet/keys/devnet/deployer.json",
  "x402/test-mainnet/keys/devnet/runtime.env",
  "x402/test-mainnet/keys/solana-usdc-drill/treasury-display.json",
  "x402/.tools/tmp/dnp-deploy-stage/deployer.json.1ac1af645942.json"
)

$existing = @()
$missing = @()
foreach ($relativePath in $secretPaths) {
  if (Test-Path -LiteralPath $relativePath) {
    $existing += $relativePath
  } else {
    $missing += $relativePath
  }
}

if ($existing.Count -eq 0) {
  throw "No known secret files were found. Nothing to export."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$resolvedOutputDir = Join-Path $root $OutputDir
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$staging = Join-Path $env:TEMP "dna-x402-secrets-$timestamp"
$payloadRoot = Join-Path $staging "payload"
New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

try {
  foreach ($relativePath in $existing) {
    $destination = Join-Path $payloadRoot $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $relativePath -Destination $destination
  }

  $manifest = [ordered]@{
    createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    repoRoot = $root.Path
    exportedFiles = $existing
    missingFiles = $missing
    warning = "Encrypted backup only. Do not commit decrypted files or plaintext archives."
  }
  $manifestPath = Join-Path $payloadRoot "SECRETS_MANIFEST.redacted.json"
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8

  $zipPath = Join-Path $staging "dna-x402-$timestamp.secrets.zip"
  $encryptedPath = Join-Path $resolvedOutputDir "dna-x402-$timestamp.secrets.zip.enc"
  Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $zipPath -Force

  $first = Read-Host "Encryption passphrase" -AsSecureString
  $second = Read-Host "Repeat encryption passphrase" -AsSecureString
  $firstPlain = Convert-SecureStringToPlainText $first
  $secondPlain = Convert-SecureStringToPlainText $second
  try {
    if ($firstPlain -ne $secondPlain) {
      throw "Passphrases did not match. Export aborted."
    }
    Invoke-OpenSslWithPassphrase -Arguments @("enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-in", $zipPath, "-out", $encryptedPath, "-pass", "stdin") -Passphrase $firstPlain
  } finally {
    $firstPlain = $null
    $secondPlain = $null
  }

  Write-Host "Encrypted secrets archive created:"
  Write-Host $encryptedPath
  Write-Host ""
  Write-Host "Files included:"
  $existing | ForEach-Object { Write-Host " - $_" }
  if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Known files not found on this machine:"
    $missing | ForEach-Object { Write-Host " - $_" }
  }
  Write-Host ""
  Write-Host "Do not commit the encrypted archive unless the passphrase is stored outside git."
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}
