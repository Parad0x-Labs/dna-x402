import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function runSolana(args: string[]): string {
  const result = spawnSync("solana", args, {
    encoding: "utf8",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`solana ${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return (result.stdout ?? "") + (result.stderr ?? "");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cluster = parseFlagValue(argv, "--cluster") ?? "devnet";
  const keypair = parseFlagValue(argv, "--keypair") ?? process.env.DEPLOYER_KEYPAIR;
  const lookupTableAddress = parseFlagValue(argv, "--alt");
  const outPath = parseFlagValue(argv, "--out")
    ?? path.resolve(process.cwd(), "reports", `alt-show-${new Date().toISOString().replace(/[:]/g, "-")}.txt`);

  if (!lookupTableAddress) {
    throw new Error("Missing --alt <LOOKUP_TABLE_ADDRESS>");
  }

  const args = ["address-lookup-table", "get", lookupTableAddress, "-u", cluster];
  if (keypair) {
    args.push("-k", keypair);
  }

  const output = runSolana(args);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, outPath, lookupTableAddress }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
