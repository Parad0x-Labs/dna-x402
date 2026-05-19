param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,
  [switch]$Force
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
  throw "openssl is required. Install OpenSSL or add it to PATH before restoring secrets."
}

$resolvedArchive = Resolve-Path $ArchivePath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$staging = Join-Path $env:TEMP "dna-x402-secrets-restore-$timestamp"
$zipPath = Join-Path $staging "secrets.zip"
$extractPath = Join-Path $staging "payload"
New-Item -ItemType Directory -Force -Path $extractPath | Out-Null

try {
  $passphrase = Read-Host "Decryption passphrase" -AsSecureString
  $plain = Convert-SecureStringToPlainText $passphrase
  try {
    Invoke-OpenSslWithPassphrase -Arguments @("enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", $resolvedArchive.Path, "-out", $zipPath, "-pass", "stdin") -Passphrase $plain
  } finally {
    $plain = $null
  }

  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $manifestPath = Join-Path $extractPath "SECRETS_MANIFEST.redacted.json"
  if (Test-Path -LiteralPath $manifestPath) {
    Write-Host "Manifest:"
    Get-Content -Path $manifestPath
  } else {
    Write-Host "No manifest found in archive."
  }

  $files = Get-ChildItem -LiteralPath $extractPath -Recurse -File |
    Where-Object { $_.Name -ne "SECRETS_MANIFEST.redacted.json" }
  if ($files.Count -eq 0) {
    throw "Archive did not contain restorable secret files."
  }

  Write-Host ""
  Write-Host "Files to restore:"
  foreach ($file in $files) {
    $relativePath = [System.IO.Path]::GetRelativePath($extractPath, $file.FullName)
    Write-Host " - $relativePath"
  }

  if (-not $Force) {
    $answer = Read-Host "Restore these files into the repo? Type RESTORE to continue"
    if ($answer -ne "RESTORE") {
      throw "Restore aborted."
    }
  }

  foreach ($file in $files) {
    $relativePath = [System.IO.Path]::GetRelativePath($extractPath, $file.FullName)
    $destination = Join-Path $root $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  }

  Write-Host "Restore complete."
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}
