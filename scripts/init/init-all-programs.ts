#!/usr/bin/env tsx
/**
 * NULL Miner init payload verifier.
 *
 * This script prints deterministic init instruction payloads for the selected
 * profile. It does not submit transactions. Use it before wiring the final
 * transaction sender so reviewers can inspect bytes and profile values.
 *
 * Usage:
 *   npx tsx scripts/init/init-all-programs.ts --profile devnet.oss
 *   npx tsx scripts/init/init-all-programs.ts --profile mainnet.commercial
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { PublicKey } from "@solana/web3.js";

interface DeployConfig {
  track: string;
  network: string;
  houseFeeBps: number;
  nullEmissionPct: number;
  lotteryHouseFeeBps: number;
  lotteryTicketPriceNull: number;
  maxNullPerEpochAtomic: number;
  epochDurationSlots: number;
  programs: Record<string, string>;
  nullMint?: string;
  rpcUrl: string;
}

function loadConfig(profile: string): DeployConfig {
  const configPath = resolve(process.cwd(), `configs/${profile}.json`);
  return JSON.parse(readFileSync(configPath, "utf8")) as DeployConfig;
}

function buildInitLotteryIx(houseFeeBps: number, ticketPriceNull: number): Uint8Array {
  const buf = Buffer.alloc(14);
  buf[0] = 0x01;
  buf.writeBigUInt64LE(BigInt(ticketPriceNull), 1);
  buf.writeUInt16LE(houseFeeBps, 9);
  buf[11] = 5;
  buf[12] = 30;
  buf[13] = 3;
  return buf;
}

function buildInitEmissionIx(
  nullMint: string,
  maxNullPerClaim: number,
  epochDuration: number,
  epochCap: number,
): Uint8Array {
  const buf = Buffer.alloc(57);
  buf[0] = 0x01;
  new PublicKey(nullMint).toBuffer().copy(buf, 1);
  buf.writeBigUInt64LE(BigInt(maxNullPerClaim), 33);
  buf.writeBigUInt64LE(BigInt(epochDuration), 41);
  buf.writeBigUInt64LE(BigInt(epochCap), 49);
  return buf;
}

function parseProfileArg(): string {
  const args = process.argv.slice(2);
  const profileIdx = args.indexOf("--profile");
  return profileIdx >= 0 ? String(args[profileIdx + 1] || "devnet.oss") : "devnet.oss";
}

async function main(): Promise<void> {
  const profileName = parseProfileArg();
  const config = loadConfig(profileName);
  const nullMint = config.nullMint ?? PublicKey.default.toBase58();
  const maxPerClaim = config.lotteryTicketPriceNull > 0
    ? config.lotteryTicketPriceNull * 100
    : 0;

  const lotteryIx = buildInitLotteryIx(
    config.lotteryHouseFeeBps,
    config.lotteryTicketPriceNull,
  );

  const emissionIx = buildInitEmissionIx(
    nullMint,
    maxPerClaim,
    config.epochDurationSlots,
    config.maxNullPerEpochAtomic,
  );

  console.log("NULL Miner init payload verifier");
  console.log(`Profile: ${profileName}`);
  console.log(`Network: ${config.network}`);
  console.log(`Track: ${config.track}`);
  console.log(`House fee bps: ${config.houseFeeBps}`);
  console.log(`Lottery fee bps: ${config.lotteryHouseFeeBps}`);
  console.log(`NULL emission pct: ${config.nullEmissionPct}`);
  console.log(`Lottery ticket price atomic: ${config.lotteryTicketPriceNull}`);
  console.log(`Epoch cap atomic: ${config.maxNullPerEpochAtomic}`);
  console.log("");
  console.log(`InitLottery hex: ${Buffer.from(lotteryIx).toString("hex")}`);
  console.log(`InitEmission hex: ${Buffer.from(emissionIx).toString("hex")}`);
  console.log("");
  console.log("Program IDs:");
  for (const [name, id] of Object.entries(config.programs)) {
    console.log(`  ${name}: ${id}`);
  }
  console.log("");
  console.log("Dry-run only: this script does not submit Solana transactions.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
