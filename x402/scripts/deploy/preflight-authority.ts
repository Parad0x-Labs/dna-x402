import { spawnSync } from "node:child_process";

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function run(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const out = spawnSync(command, args, { encoding: "utf8", env: process.env });
  return {
    status: out.status ?? 1,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

function extractAuthority(programShowOutput: string): string | undefined {
  const match = programShowOutput.match(/Authority:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return match?.[1];
}

function extractSignerPubkey(addressOutput: string): string | undefined {
  const value = addressOutput.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return undefined;
  }
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const programId = parseFlagValue(args, "--program-id");
  const cluster = parseFlagValue(args, "--cluster") ?? "devnet";
  const authorityKeypair = parseFlagValue(args, "--upgrade-authority-keypair")
    ?? parseFlagValue(args, "--upgrade-authority");

  if (!programId) {
    throw new Error("Missing --program-id");
  }
  if (!authorityKeypair) {
    throw new Error("Missing --upgrade-authority-keypair");
  }

  const signerAddress = run("solana", ["address", "-u", cluster, "-k", authorityKeypair]);
  if (signerAddress.status !== 0) {
    throw new Error(`Unable to read signer pubkey for supplied authority keypair (${signerAddress.stderr.trim()})`);
  }
  const signerPubkey = extractSignerPubkey(signerAddress.stdout);
  if (!signerPubkey) {
    throw new Error("Unable to parse authority signer pubkey");
  }

  const programShow = run("solana", ["program", "show", programId, "-u", cluster]);
  if (programShow.status !== 0) {
    throw new Error(`Unable to read program metadata (${programShow.stderr.trim()})`);
  }
  const onchainAuthority = extractAuthority(programShow.stdout);
  if (!onchainAuthority) {
    throw new Error("Unable to parse on-chain upgrade authority from program metadata");
  }

  const match = onchainAuthority === signerPubkey;

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: match,
    programId,
    cluster,
    onchainAuthority,
    signerPubkey,
    authorityMatch: match,
  }, null, 2));

  if (!match) {
    throw new Error(`upgrade authority mismatch: onchain=${onchainAuthority} signer=${signerPubkey}`);
  }
}

main();
