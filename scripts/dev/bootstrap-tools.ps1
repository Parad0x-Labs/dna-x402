$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ToolsRoot = Join-Path $RepoRoot ".tools"
$ToolsBin = Join-Path $ToolsRoot "bin"
$CacheRoot = Join-Path $ToolsRoot "cache"
$PortableNodeDir = Join-Path $ToolsRoot "node-portable"
$PortableNode = Join-Path $PortableNodeDir "node.exe"
$NpmRoot = Join-Path $ToolsRoot "npm"
$BootstrapNodeRoot = Join-Path $ToolsRoot "bootstrap-node"
$RustupRoot = Join-Path $ToolsRoot "rustup"
$CargoHome = Join-Path $RustupRoot "cargo"
$RustupHome = Join-Path $RustupRoot "rustup-home"
$SolanaVersion = "1.18.26"
$SolanaRoot = Join-Path $ToolsRoot ("solana-v" + $SolanaVersion)
$SolanaBin = Join-Path $SolanaRoot "solana-release\bin"
$PlaywrightBrowsers = Join-Path $ToolsRoot "playwright-browsers"
$NpmCache = Join-Path $ToolsRoot "npm-cache"

New-Item -ItemType Directory -Force -Path $ToolsRoot, $ToolsBin, $CacheRoot, $PortableNodeDir, $BootstrapNodeRoot, $CargoHome, $RustupHome, $PlaywrightBrowsers, $NpmCache | Out-Null

function Write-Step([string]$Message) {
  Write-Output ""
  Write-Output "==> $Message"
}

function Write-CmdWrapper {
  param(
    [string]$Path,
    [string[]]$Lines
  )
  Set-Content -Path $Path -Value ($Lines -join "`r`n") -Encoding ASCII
}

function Find-BootstrapNodeSource {
  $candidatePaths = @()

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    $candidatePaths += $command.Source
  }

  $candidatePaths += @(
    "C:\Program Files\cursor\resources\app\resources\helpers\node.exe",
    "C:\Program Files\Cursor\resources\app\resources\helpers\node.exe"
  )

  foreach ($candidate in $candidatePaths | Select-Object -Unique) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  throw "Unable to find a bootstrap Node executable. Expected Cursor helper Node or an existing node.exe on PATH."
}

function Invoke-NodeInline {
  param(
    [string]$Script,
    [string[]]$NodeArgs = @()
  )
  $temp = Join-Path $CacheRoot ("tmp-" + [guid]::NewGuid().ToString("N") + ".js")
  Set-Content -Path $temp -Value $Script -Encoding ASCII
  try {
    & $PortableNode $temp @NodeArgs
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

function Download-FileWithNode {
  param(
    [string]$Url,
    [string]$OutFile
  )

  $downloadScript = @'
const fs = require("fs");
const https = require("https");
const path = require("path");

const url = process.argv[2];
const outFile = process.argv[3];

function download(currentUrl, redirectsLeft) {
  https.get(currentUrl, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      if (redirectsLeft <= 0) {
        console.error(`too many redirects for ${url}`);
        process.exit(1);
      }
      const next = new URL(res.headers.location, currentUrl).toString();
      res.resume();
      download(next, redirectsLeft - 1);
      return;
    }

    if (res.statusCode !== 200) {
      console.error(`download status ${res.statusCode} for ${currentUrl}`);
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const file = fs.createWriteStream(outFile);
    res.pipe(file);
    file.on("finish", () => file.close(() => console.log(outFile)));
    file.on("error", (error) => {
      console.error(error.message);
      process.exit(1);
    });
  }).on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
}

download(url, 10);
'@

  Invoke-NodeInline -Script $downloadScript -NodeArgs @($Url, $OutFile) | Out-Null
}

function Expand-ArchiveWithTar {
  param(
    [string]$ArchivePath,
    [string]$Destination
  )

  if (Test-Path $Destination) {
    Remove-Item $Destination -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  tar -xf $ArchivePath -C $Destination
}

function Expand-TarBz2WithNode {
  param(
    [string]$ArchivePath,
    [string]$Destination
  )

  if (Test-Path $Destination) {
    Remove-Item $Destination -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  $extractScript = @'
const fs = require("fs");
const { pipeline } = require("stream/promises");

const archivePath = process.argv[2];
const destination = process.argv[3];
const tarModulePath = process.argv[4];
const unbzip2ModulePath = process.argv[5];

const tar = require(tarModulePath);
const unbzip2Stream = require(unbzip2ModulePath);

(async () => {
  await pipeline(
    fs.createReadStream(archivePath),
    unbzip2Stream(),
    tar.x({ cwd: destination })
  );
  console.log(destination);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
'@

  Invoke-NodeInline -Script $extractScript -NodeArgs @(
    $ArchivePath,
    $Destination,
    (Join-Path $NpmRoot "package\node_modules\tar"),
    (Join-Path $BootstrapNodeRoot "node_modules\unbzip2-stream")
  ) | Out-Null
}

Write-Step "Preparing portable Node"
$bootstrapNode = Find-BootstrapNodeSource
Copy-Item $bootstrapNode $PortableNode -Force
& $PortableNode -v

Write-Step "Installing portable npm"
$npmScript = @'
const https = require("https");
const path = require("path");
const outDir = process.argv[2];
https.get("https://registry.npmjs.org/npm/latest", (res) => {
  let data = "";
  res.on("data", (chunk) => data += chunk);
  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.error(`metadata status ${res.statusCode}`);
      process.exit(1);
    }
    const meta = JSON.parse(data);
    console.log(path.join(outDir, `npm-${meta.version}.tgz`));
  });
}).on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
'@
$npmTarball = Invoke-NodeInline -Script $npmScript -NodeArgs @($CacheRoot)
Download-FileWithNode -Url (Invoke-NodeInline -Script @'
const https = require("https");
https.get("https://registry.npmjs.org/npm/latest", (res) => {
  let data = "";
  res.on("data", (chunk) => data += chunk);
  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.error(`metadata status ${res.statusCode}`);
      process.exit(1);
    }
    const meta = JSON.parse(data);
    console.log(meta.dist.tarball);
  });
}).on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
'@) -OutFile $npmTarball
if (Test-Path $NpmRoot) {
  Remove-Item $NpmRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $NpmRoot | Out-Null
tar -xf $npmTarball -C $NpmRoot
& $PortableNode (Join-Path $NpmRoot "package\bin\npm-cli.js") -v

Write-Step "Installing bootstrap archive helper"
$env:npm_config_cache = $NpmCache
if (-not (Test-Path (Join-Path $BootstrapNodeRoot "node_modules\unbzip2-stream"))) {
  & $PortableNode (Join-Path $NpmRoot "package\bin\npm-cli.js") install --prefix $BootstrapNodeRoot --no-save --no-package-lock unbzip2-stream@1.4.3
}
Write-Output "unbzip2-stream ready"

Write-Step "Writing npm wrappers"
Write-CmdWrapper -Path (Join-Path $ToolsBin "npm.cmd") -Lines @(
  "@echo off",
  "`"%~dp0..\node-portable\node.exe`" `"%~dp0..\npm\package\bin\npm-cli.js`" %*"
)
Write-CmdWrapper -Path (Join-Path $ToolsBin "npx.cmd") -Lines @(
  "@echo off",
  "`"%~dp0..\node-portable\node.exe`" `"%~dp0..\npm\package\bin\npx-cli.js`" %*"
)
& $PortableNode -v

Write-Step "Installing portable Rust toolchain"
$rustupInit = Join-Path $CacheRoot "rustup-init.exe"
Download-FileWithNode -Url "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" -OutFile $rustupInit
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
& $rustupInit -y --profile minimal --default-toolchain stable --no-modify-path
Write-CmdWrapper -Path (Join-Path $ToolsBin "cargo.cmd") -Lines @(
  "@echo off",
  "set `"CARGO_HOME=%~dp0..\rustup\cargo`"",
  "set `"RUSTUP_HOME=%~dp0..\rustup\rustup-home`"",
  "`"%~dp0..\rustup\cargo\bin\cargo.exe`" %*"
)
Write-CmdWrapper -Path (Join-Path $ToolsBin "rustc.cmd") -Lines @(
  "@echo off",
  "set `"CARGO_HOME=%~dp0..\rustup\cargo`"",
  "set `"RUSTUP_HOME=%~dp0..\rustup\rustup-home`"",
  "`"%~dp0..\rustup\cargo\bin\rustc.exe`" %*"
)
& (Join-Path $CargoHome "bin\cargo.exe") -V
& (Join-Path $CargoHome "bin\rustc.exe") -V

Write-Step "Installing Solana CLI $SolanaVersion"
$solanaArchive = Join-Path $CacheRoot ("solana-release-x86_64-pc-windows-msvc-v" + $SolanaVersion + ".tar.bz2")
Download-FileWithNode -Url ("https://github.com/solana-labs/solana/releases/download/v" + $SolanaVersion + "/solana-release-x86_64-pc-windows-msvc.tar.bz2") -OutFile $solanaArchive
Expand-TarBz2WithNode -ArchivePath $solanaArchive -Destination $SolanaRoot
& (Join-Path $SolanaBin "solana.exe") --version
& (Join-Path $SolanaBin "solana-keygen.exe") --version

Write-Step "Installing Playwright browsers on G:"
$env:PLAYWRIGHT_BROWSERS_PATH = $PlaywrightBrowsers
$env:npm_config_cache = $NpmCache
$env:Path = "$ToolsBin;$PortableNodeDir;" + (Join-Path $CargoHome "bin") + ";" + $SolanaBin + ";" + $env:Path
$playwrightBrowsersJson = Join-Path $RepoRoot "site-agent\node_modules\playwright-core\browsers.json"
if (Test-Path $playwrightBrowsersJson) {
  $registry = Get-Content $playwrightBrowsersJson -Raw | ConvertFrom-Json
  $chromium = $registry.browsers | Where-Object { $_.name -eq "chromium" } | Select-Object -First 1
  $chromiumHeadlessShell = $registry.browsers | Where-Object { $_.name -eq "chromium-headless-shell" } | Select-Object -First 1
  $winldd = $registry.browsers | Where-Object { $_.name -eq "winldd" } | Select-Object -First 1

  if (-not $chromium) {
    throw "Unable to locate Chromium metadata in site-agent/node_modules/playwright-core/browsers.json"
  }

  $chromiumArchive = Join-Path $CacheRoot ("playwright-chromium-" + $chromium.revision + ".zip")
  $chromiumDir = Join-Path $PlaywrightBrowsers ("chromium-" + $chromium.revision)
  Download-FileWithNode -Url ("https://cdn.playwright.dev/builds/cft/" + $chromium.browserVersion + "/win64/chrome-win64.zip") -OutFile $chromiumArchive
  Expand-ArchiveWithTar -ArchivePath $chromiumArchive -Destination $chromiumDir
  Set-Content -Path (Join-Path $chromiumDir "INSTALLATION_COMPLETE") -Value "" -Encoding ASCII
  Write-Output ("Installed Chromium into " + $chromiumDir)

  if ($chromiumHeadlessShell) {
    $headlessArchive = Join-Path $CacheRoot ("playwright-chromium-headless-shell-" + $chromiumHeadlessShell.revision + ".zip")
    $headlessDir = Join-Path $PlaywrightBrowsers ("chromium_headless_shell-" + $chromiumHeadlessShell.revision)
    Download-FileWithNode -Url ("https://cdn.playwright.dev/builds/cft/" + $chromiumHeadlessShell.browserVersion + "/win64/chrome-headless-shell-win64.zip") -OutFile $headlessArchive
    Expand-ArchiveWithTar -ArchivePath $headlessArchive -Destination $headlessDir
    Set-Content -Path (Join-Path $headlessDir "INSTALLATION_COMPLETE") -Value "" -Encoding ASCII
    Write-Output ("Installed Chromium headless shell into " + $headlessDir)
  }

  if ($winldd) {
    $winlddArchive = Join-Path $CacheRoot ("playwright-winldd-" + $winldd.revision + ".zip")
    $winlddDir = Join-Path $PlaywrightBrowsers ("winldd-" + $winldd.revision)
    Download-FileWithNode -Url ("https://cdn.playwright.dev/builds/winldd/" + $winldd.revision + "/winldd-win64.zip") -OutFile $winlddArchive
    Expand-ArchiveWithTar -ArchivePath $winlddArchive -Destination $winlddDir
    Set-Content -Path (Join-Path $winlddDir "INSTALLATION_COMPLETE") -Value "" -Encoding ASCII
    Write-Output ("Installed winldd into " + $winlddDir)
  }
} else {
  Write-Output "Skipping Playwright browser install because site-agent dependencies are not installed yet."
}

Write-Step "Bootstrap complete"
Write-Output "Use scripts\\dev\\use-tools.ps1 to load the local toolchain into the current shell."
