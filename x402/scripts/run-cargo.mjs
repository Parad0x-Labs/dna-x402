import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "..");

const cargoBin = process.platform === "win32" ? "cargo.exe" : "cargo";
const localCargoDir = join(repoRoot, ".tools", "rustup", "cargo", "bin");
const localCargo = join(localCargoDir, cargoBin);
const cargo = existsSync(localCargo) ? localCargo : "cargo";

const env = { ...process.env };
const localCargoHome = join(repoRoot, ".tools", "rustup", "cargo");
const localRustupHome = join(repoRoot, ".tools", "rustup", "rustup-home");

if (existsSync(localCargoHome) && !env.CARGO_HOME) {
  env.CARGO_HOME = localCargoHome;
}

if (existsSync(localRustupHome) && !env.RUSTUP_HOME) {
  env.RUSTUP_HOME = localRustupHome;
}

if (existsSync(localCargoDir)) {
  env.PATH = `${localCargoDir}${delimiter}${env.PATH ?? ""}`;
}

const result = spawnSync(cargo, process.argv.slice(2), {
  cwd: packageRoot,
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`cargo launcher failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
