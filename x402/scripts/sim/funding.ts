import fs from "node:fs";
import path from "node:path";
import {
  Commitment,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { EphemeralAgentWallet } from "./walletFactory.js";
import { withRpcRetry } from "./retry.js";

export interface FundingSnapshot {
  timestamp: string;
  sol: Array<{ agentId: string; pubkey: string; lamports: string; sol: string }>;
  token?: {
    mint: string;
    recipientOwner: string;
    recipientAta: string;
    rows: Array<{ agentId: string; pubkey: string; amountAtomic: string }>;
  };
}

function toSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
}

export function loadKeypairFromPath(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw) || raw.length < 64) {
    throw new Error(`invalid keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

export function resolveFunderKeypairPath(): string {
  const envPath = process.env.GAUNTLET_FUNDER_KEYPAIR;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  const fallback = path.join(process.env.HOME ?? "", ".config", "solana", "devnet-deployer.json");
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  throw new Error("missing GAUNTLET_FUNDER_KEYPAIR and default ~/.config/solana/devnet-deployer.json not found");
}

async function lamportsFor(connection: Connection, pubkey: PublicKey, commitment: Commitment): Promise<bigint> {
  const value = await withRpcRetry("getBalance", () => connection.getBalance(pubkey, commitment));
  return BigInt(value);
}

export async function ensureSolFunding(params: {
  connection: Connection;
  funder: Keypair;
  wallets: EphemeralAgentWallet[];
  minLamportsPerWallet: bigint;
  commitment?: Commitment;
}): Promise<void> {
  const commitment = params.commitment ?? "confirmed";
  const targetLamports = params.minLamportsPerWallet;
  const totalRequired = targetLamports * BigInt(params.wallets.length);
  const funderBalance = await lamportsFor(params.connection, params.funder.publicKey, commitment);
  if (funderBalance < totalRequired) {
    throw new Error(
      `insufficient devnet SOL in funder ${params.funder.publicKey.toBase58()} (${toSol(funderBalance)} SOL) required >= ${toSol(totalRequired)} SOL`,
    );
  }

  for (const wallet of params.wallets) {
    const current = await lamportsFor(params.connection, wallet.pubkey, commitment);
    if (current >= targetLamports) {
      continue;
    }
    const topup = targetLamports - current;
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: params.funder.publicKey,
      toPubkey: wallet.pubkey,
      lamports: Number(topup),
    }));
    await withRpcRetry("sendAndConfirmTransaction:sol-funding", () => sendAndConfirmTransaction(
      params.connection,
      tx,
      [params.funder],
      {
        commitment,
        preflightCommitment: commitment,
      },
    ));
  }
}

export async function snapshotSolBalances(params: {
  connection: Connection;
  wallets: EphemeralAgentWallet[];
  commitment?: Commitment;
}): Promise<Array<{ agentId: string; pubkey: string; lamports: string; sol: string }>> {
  const commitment = params.commitment ?? "confirmed";
  const rows: Array<{ agentId: string; pubkey: string; lamports: string; sol: string }> = [];
  for (const wallet of params.wallets) {
    const lamports = await lamportsFor(params.connection, wallet.pubkey, commitment);
    rows.push({
      agentId: wallet.agentId,
      pubkey: wallet.pubkey.toBase58(),
      lamports: lamports.toString(10),
      sol: toSol(lamports),
    });
  }
  return rows;
}

export async function createGauntletMintAndFund(params: {
  connection: Connection;
  funder: Keypair;
  recipientOwner: PublicKey;
  wallets: EphemeralAgentWallet[];
  decimals: number;
  amountPerWalletAtomic: bigint;
  commitment?: Commitment;
}): Promise<{
  mint: PublicKey;
  recipientAta: PublicKey;
  walletAtas: Map<string, PublicKey>;
}> {
  const commitment = params.commitment ?? "confirmed";
  const mint = await withRpcRetry("createMint", () => createMint(
    params.connection,
    params.funder,
    params.funder.publicKey,
    null,
    params.decimals,
    undefined,
    { commitment, preflightCommitment: commitment },
    TOKEN_PROGRAM_ID,
  ));

  const recipientAtaAccount = await withRpcRetry("getOrCreateATA:recipient", () => getOrCreateAssociatedTokenAccount(
    params.connection,
    params.funder,
    mint,
    params.recipientOwner,
    false,
    commitment,
    { commitment, preflightCommitment: commitment },
    TOKEN_PROGRAM_ID,
  ));

  const walletAtas = new Map<string, PublicKey>();
  for (const wallet of params.wallets) {
    const ata = await withRpcRetry(`getOrCreateATA:${wallet.agentId}`, () => getOrCreateAssociatedTokenAccount(
      params.connection,
      params.funder,
      mint,
      wallet.pubkey,
      false,
      commitment,
      { commitment, preflightCommitment: commitment },
      TOKEN_PROGRAM_ID,
    ));
    walletAtas.set(wallet.agentId, ata.address);

    await withRpcRetry(`mintTo:${wallet.agentId}`, () => mintTo(
      params.connection,
      params.funder,
      mint,
      ata.address,
      params.funder,
      Number(params.amountPerWalletAtomic),
      [],
      { commitment, preflightCommitment: commitment },
      TOKEN_PROGRAM_ID,
    ));
  }

  return {
    mint,
    recipientAta: recipientAtaAccount.address,
    walletAtas,
  };
}

export async function fundExistingMint(params: {
  connection: Connection;
  funder: Keypair;
  mint: PublicKey;
  recipientOwner: PublicKey;
  wallets: EphemeralAgentWallet[];
  amountPerWalletAtomic: bigint;
  commitment?: Commitment;
}): Promise<{
  recipientAta: PublicKey;
  walletAtas: Map<string, PublicKey>;
}> {
  const commitment = params.commitment ?? "confirmed";
  const recipientAtaAccount = await withRpcRetry("getOrCreateATA:recipient-existing", () => getOrCreateAssociatedTokenAccount(
    params.connection,
    params.funder,
    params.mint,
    params.recipientOwner,
    false,
    commitment,
    { commitment, preflightCommitment: commitment },
    TOKEN_PROGRAM_ID,
  ));
  const walletAtas = new Map<string, PublicKey>();
  for (const wallet of params.wallets) {
    const ata = await withRpcRetry(`getOrCreateATA-existing:${wallet.agentId}`, () => getOrCreateAssociatedTokenAccount(
      params.connection,
      params.funder,
      params.mint,
      wallet.pubkey,
      false,
      commitment,
      { commitment, preflightCommitment: commitment },
      TOKEN_PROGRAM_ID,
    ));
    walletAtas.set(wallet.agentId, ata.address);
    await withRpcRetry(`mintTo-existing:${wallet.agentId}`, () => mintTo(
      params.connection,
      params.funder,
      params.mint,
      ata.address,
      params.funder,
      Number(params.amountPerWalletAtomic),
      [],
      { commitment, preflightCommitment: commitment },
      TOKEN_PROGRAM_ID,
    ));
  }
  return {
    recipientAta: recipientAtaAccount.address,
    walletAtas,
  };
}

export async function snapshotTokenBalances(params: {
  connection: Connection;
  wallets: EphemeralAgentWallet[];
  mint: PublicKey;
  commitment?: Commitment;
}): Promise<Array<{ agentId: string; pubkey: string; amountAtomic: string }>> {
  const commitment = params.commitment ?? "confirmed";
  const rows: Array<{ agentId: string; pubkey: string; amountAtomic: string }> = [];
  for (const wallet of params.wallets) {
    const accounts = await withRpcRetry("getTokenAccountsByOwner", () => params.connection.getTokenAccountsByOwner(
      wallet.pubkey,
      { mint: params.mint },
      { commitment },
    ));
    let total = 0n;
    for (const account of accounts.value) {
      const parsed = await withRpcRetry("getParsedAccountInfo", () => params.connection.getParsedAccountInfo(account.pubkey, commitment));
      const value = parsed.value as {
        data?: {
          parsed?: {
            info?: {
              tokenAmount?: {
                amount?: string;
              };
            };
          };
        };
      } | null;
      const amount = value?.data?.parsed?.info?.tokenAmount?.amount;
      if (amount && /^\d+$/.test(amount)) {
        total += BigInt(amount);
      }
    }
    rows.push({
      agentId: wallet.agentId,
      pubkey: wallet.pubkey.toBase58(),
      amountAtomic: total.toString(10),
    });
  }
  return rows;
}
