import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

export type AgentRole = "seller" | "buyer" | "bot";

export interface EphemeralAgentWallet {
  agentId: string;
  role: AgentRole;
  keypair: Keypair;
  pubkey: PublicKey;
  keyPath: string;
}

function roleForIndex(index: number): AgentRole {
  if (index < 8) {
    return "seller";
  }
  if (index < 18) {
    return "buyer";
  }
  return "bot";
}

function deterministicSeed(baseSeed: string, index: number): Uint8Array {
  const digest = crypto.createHash("sha256").update(`${baseSeed}:${index}`).digest();
  return new Uint8Array(digest.subarray(0, 32));
}

function asRoleSlug(role: AgentRole): string {
  switch (role) {
    case "seller":
      return "seller";
    case "buyer":
      return "buyer";
    case "bot":
      return "bot";
    default:
      return "agent";
  }
}

export function generateEphemeralWallets(params: {
  count: number;
  outDir: string;
  seed: string;
}): EphemeralAgentWallet[] {
  if (params.count <= 0) {
    throw new Error("wallet count must be positive");
  }
  const keysDir = path.join(params.outDir, "keys");
  fs.mkdirSync(keysDir, { recursive: true });

  const wallets: EphemeralAgentWallet[] = [];
  for (let index = 0; index < params.count; index += 1) {
    const role = roleForIndex(index);
    const keypair = Keypair.fromSeed(deterministicSeed(params.seed, index));
    const slot = `${String(index + 1).padStart(2, "0")}`;
    const filename = `${asRoleSlug(role)}-${slot}.json`;
    const keyPath = path.join(keysDir, filename);
    fs.writeFileSync(keyPath, JSON.stringify(Array.from(keypair.secretKey)));
    fs.chmodSync(keyPath, 0o600);
    wallets.push({
      agentId: `${asRoleSlug(role)}-${slot}`,
      role,
      keypair,
      pubkey: keypair.publicKey,
      keyPath,
    });
  }
  return wallets;
}

export function redactWallets(wallets: EphemeralAgentWallet[]): Array<{
  agentId: string;
  role: AgentRole;
  pubkey: string;
}> {
  return wallets.map((wallet) => ({
    agentId: wallet.agentId,
    role: wallet.role,
    pubkey: wallet.pubkey.toBase58(),
  }));
}

