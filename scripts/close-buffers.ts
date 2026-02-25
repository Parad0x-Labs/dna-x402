import path from "node:path";
import {
  getAddress,
  getBalanceLamports,
  getBufferAccounts,
  hasFlag,
  nowStamp,
  parseFlagValue,
  runSolana,
  stageSignerPath,
  toSol,
  writeJson,
} from "./_solanaCli.js";

interface CloseBuffersReport {
  generatedAt: string;
  cluster: string;
  keypair?: string;
  keypairUsedForCommand?: string;
  authority?: string;
  authorityUsedForCommand?: string;
  recipient: string;
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  balanceBeforeLamports: string;
  balanceAfterLamports: string;
  deltaLamports: string;
  deltaSol: string;
  buffersBefore: string[];
  buffersAfter: string[];
  closedBuffers: string[];
  dryRun: boolean;
}

function usage(): string {
  return [
    "Usage: tsx scripts/close-buffers.ts [options]",
    "",
    "Options:",
    "  --cluster <devnet|testnet|mainnet-beta|url>   Cluster or RPC moniker (default: devnet)",
    "  --keypair <path>                                Fee payer keypair path",
    "  --authority <path>                              Buffer authority signer (default: keypair/default)",
    "  --authority-keypair <path>                      Alias for --authority",
    "  --recipient <pubkey|keypair>                    Recipient for reclaimed lamports (default: deployer address)",
    "  --dry-run                                       Print command/report without closing buffers",
    "  --out <path>                                    Output JSON report path",
    "  --help                                          Show this help",
  ].join("\n");
}

function computeClosed(before: string[], after: string[]): string[] {
  const afterSet = new Set(after);
  return before.filter((value) => !afterSet.has(value));
}

function main(): void {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return;
  }

  const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const repoRoot = path.resolve(scriptDir, "..");

  const cluster = parseFlagValue(argv, "--cluster") ?? "devnet";
  const keypair = parseFlagValue(argv, "--keypair");
  const authority = parseFlagValue(argv, "--authority-keypair")
    ?? parseFlagValue(argv, "--authority");
  const stagedKeypair = stageSignerPath(keypair);
  const stagedAuthority = stageSignerPath(authority);
  const outPath = parseFlagValue(argv, "--out")
    ?? path.join(repoRoot, "reports", `close-buffers-${nowStamp()}.json`);
  const dryRun = hasFlag(argv, "--dry-run");

  const context = { cluster, keypair: stagedKeypair };
  const deployerAddress = getAddress(context);
  const recipient = parseFlagValue(argv, "--recipient") ?? deployerAddress;

  const beforeBalance = getBalanceLamports(deployerAddress, context);
  const beforeBuffers = getBufferAccounts(context);

  const args = ["program", "close", "--buffers", "-u", cluster, "--output", "json-compact", "--bypass-warning", "--recipient", recipient];
  if (stagedKeypair) {
    args.push("-k", stagedKeypair);
  }
  if (stagedAuthority) {
    args.push("--authority", stagedAuthority);
  }

  const result = dryRun
    ? {
      status: 0,
      stdout: "dry-run: close buffers skipped",
      stderr: "",
      cmd: `solana ${args.join(" ")}`,
    }
    : runSolana(args, repoRoot);

  const afterBalance = getBalanceLamports(deployerAddress, context);
  const afterBuffers = getBufferAccounts(context);
  const delta = afterBalance - beforeBalance;
  const closedBuffers = computeClosed(beforeBuffers, afterBuffers);

  const report: CloseBuffersReport = {
    generatedAt: new Date().toISOString(),
    cluster,
    keypair,
    keypairUsedForCommand: stagedKeypair,
    authority,
    authorityUsedForCommand: stagedAuthority,
    recipient,
    success: result.status === 0,
    command: result.cmd,
    stdout: result.stdout,
    stderr: result.stderr,
    balanceBeforeLamports: beforeBalance.toString(10),
    balanceAfterLamports: afterBalance.toString(10),
    deltaLamports: delta.toString(10),
    deltaSol: toSol(delta),
    buffersBefore: beforeBuffers,
    buffersAfter: afterBuffers,
    closedBuffers,
    dryRun,
  };

  writeJson(outPath, report);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: report.success,
    reportPath: outPath,
    cluster,
    deployerAddress,
    buffersClosed: closedBuffers.length,
    deltaLamports: report.deltaLamports,
    deltaSol: report.deltaSol,
  }, null, 2));

  if (!report.success) {
    process.exitCode = 1;
  }
}

main();
