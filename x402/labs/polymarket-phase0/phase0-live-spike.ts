import { loadPhase0Env } from "./phase0-env.js";

type Mode = "dry-run" | "live";

function modeFromArgs(args: string[]): Mode {
  return args.includes("--live") ? "live" : "dry-run";
}

async function verifySdkImports(): Promise<string[]> {
  const loaded: string[] = [];
  await import("@polymarket/clob-client-v2");
  loaded.push("@polymarket/clob-client-v2");
  await import("@polymarket/builder-relayer-client");
  loaded.push("@polymarket/builder-relayer-client");
  await import("@polymarket/builder-signing-sdk");
  loaded.push("@polymarket/builder-signing-sdk");
  await import("viem");
  loaded.push("viem");
  return loaded;
}

async function main(): Promise<void> {
  const loadedEnvPath = loadPhase0Env();
  const mode = modeFromArgs(process.argv.slice(2));
  const loaded = await verifySdkImports();

  if (mode === "live") {
    // TODO(phase0-wallet-signing-compatibility): live CLOB semantics must be
    // proven through the browser-local signer harness, not a backend signer.
    throw new Error("Backend wallet-signing live spike is disabled. Use `npm run phase0:browser` and sign from a browser-local EVM wallet.");
  }

  console.log(JSON.stringify({
    ok: true,
    mode,
    loaded,
    loadedEnvPath,
    moneyMovement: "disabled",
    backendWalletSigning: "forbidden",
    next: "Use phase0:browser for live-safe SDK validation with a browser-local signer.",
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
