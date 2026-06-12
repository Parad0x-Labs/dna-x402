/**
 * stealth.ts — high-level NullPay private-pay orchestration for the portal.
 *
 * Three flows, all client-side and non-custodial:
 *   - buildPrivatePayment(): sender derives a one-time address P and pays SOL or
 *     USDC to it, with a Memo announce + a Resolve ix (so the recipient can find
 *     the payment by scanning their domain PDA).
 *   - scanInbox(): recipient (holding keys derived from their wallet signature)
 *     scans their domain PDA's announces, recomputes each one-time address, and
 *     reports the ones holding funds.
 *   - buildSweepTxs(): recipient sweeps a one-time address to a wallet they
 *     control, signing with the raw stealth scalar (no Phantom — P is not a
 *     standard wallet). Sweeps reclaim ALL recoverable lamports.
 *
 * Funds are never stranded in a key the user cannot reproduce: the keys come from
 * the wallet signature (keysFromWalletSignature) and sweeps target the user's own
 * wallet. See nullpay.ts NULLPAY_KEY_MESSAGE.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  derive,
  recipientOneTime,
  signWithStealthScalar,
  toHex,
  randomSeed32,
  type StealthKeys,
} from "./nullpay";
import {
  auctionDomainPda,
  ataOf,
  buildAnnounce,
  ixCloseAccount,
  ixCreateAtaIdempotent,
  ixMemo,
  ixResolve,
  ixSplTransfer,
  parseAnnounce,
  TOKEN_PROGRAM,
  usdcMintFor,
  USDC_DECIMALS,
} from "./null-sdk";
import { getConnectionForCluster } from "./chain";
import type { Cluster } from "./cluster";

export type Asset = "SOL" | "USDC";

/** Dust SOL sent alongside a USDC payment so the one-time address can pay its own
 *  sweep fee + the destination-ATA rent. ~0.0045 SOL covers both with headroom. */
const USDC_DUST_LAMPORTS = Math.floor(0.0045 * LAMPORTS_PER_SOL);
const TX_FEE_LAMPORTS = 5000;

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

// ── SENDER: build a private payment to <name>.null ────────────────────────────

export interface BuiltPayment {
  instructions: TransactionInstruction[];
  stealthPub: string; // the one-time address P (base58)
  ephemHex: string; // R, also embedded in the announce
  computeUnits: number;
}

/**
 * Build the instructions for a private payment. `meta64` is the recipient's
 * published stealth meta (from resolveStealthMeta). amountAtomic is lamports for
 * SOL or 6-dp atomic for USDC.
 */
export function buildPrivatePayment(input: {
  cluster: Cluster;
  sender: PublicKey;
  name: string;
  meta64: Uint8Array;
  asset: Asset;
  amountAtomic: bigint;
  resolveIx: TransactionInstruction; // pre-derived (async) Resolve ix
}): BuiltPayment {
  const { cluster, sender, name, meta64, asset, amountAtomic, resolveIx } = input;
  const { stealthPub, ephemPub } = derive(meta64, randomSeed32());
  const P = new PublicKey(stealthPub);
  const ephemHex = toHex(ephemPub);
  const announce = ixMemo(buildAnnounce(name, ephemHex));

  const ixs: TransactionInstruction[] = [];
  if (asset === "SOL") {
    ixs.push(
      SystemProgram.transfer({ fromPubkey: sender, toPubkey: P, lamports: Number(amountAtomic) }),
      announce,
      resolveIx,
    );
  } else {
    const mint = usdcMintFor(cluster);
    const senderAta = ataOf(sender, mint, TOKEN_PROGRAM);
    const { ata: pAta, ix: createPAta } = ixCreateAtaIdempotent(sender, P, mint, TOKEN_PROGRAM);
    ixs.push(
      createPAta,
      ixSplTransfer(senderAta, pAta, sender, amountAtomic, TOKEN_PROGRAM),
      SystemProgram.transfer({ fromPubkey: sender, toPubkey: P, lamports: USDC_DUST_LAMPORTS }),
      announce,
      resolveIx,
    );
  }
  return { instructions: ixs, stealthPub: P.toBase58(), ephemHex, computeUnits: asset === "SOL" ? 60_000 : 120_000 };
}

/** Async helper to pre-build the Resolve ix for buildPrivatePayment. */
export function resolveIxFor(cluster: Cluster, name: string) {
  return ixResolve(cluster, name);
}

// ── RECIPIENT: scan the inbox for a name ──────────────────────────────────────

export interface IncomingPayment {
  ephemHex: string;
  stealthPub: string; // one-time address P (base58)
  p: bigint; // the spend scalar (held in memory only)
  solLamports: number; // SOL sitting at P
  usdcAtomic: bigint; // USDC sitting at P's ATA
  sig: string; // the announce tx signature (for the explorer)
}

interface ParsedMemoIx {
  program?: string;
  programId?: string;
  parsed?: unknown;
}

/**
 * Scan a single owned name's inbox: getSignaturesForAddress on its domain PDA,
 * pull the announce memos, recompute each one-time address with the view key,
 * and return those that currently hold funds.
 */
export async function scanInbox(input: {
  cluster: Cluster;
  keys: StealthKeys;
  name: string;
  limit?: number;
}): Promise<IncomingPayment[]> {
  const { cluster, keys, name, limit = 200 } = input;
  const conn = getConnectionForCluster(cluster);
  const domainPda = await auctionDomainPda(cluster, name);
  const usdcMint = usdcMintFor(cluster);

  const sigs = await conn.getSignaturesForAddress(domainPda, { limit });
  const seen = new Set<string>();
  const out: IncomingPayment[] = [];

  for (const s of sigs) {
    let announceHex: { name: string; ephemHex: string } | null = null;
    try {
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const ixns = tx.transaction.message.instructions as unknown as ParsedMemoIx[];
      for (const ix of ixns) {
        const isMemo = ix.program === "spl-memo" || ix.programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
        if (isMemo && typeof ix.parsed === "string") {
          const a = parseAnnounce(ix.parsed);
          if (a && a.name === name) { announceHex = a; break; }
        }
      }
    } catch {
      continue;
    }
    if (!announceHex) continue;

    let one: { p: bigint; stealthPub: Uint8Array };
    try {
      one = recipientOneTime(keys, hexToBytes(announceHex.ephemHex));
    } catch {
      continue;
    }
    const P = new PublicKey(one.stealthPub);
    const pStr = P.toBase58();
    if (seen.has(pStr)) continue;
    seen.add(pStr);

    const solLamports = await conn.getBalance(P);
    let usdcAtomic = 0n;
    try {
      const ata = ataOf(P, usdcMint, TOKEN_PROGRAM);
      const info = await conn.getTokenAccountBalance(ata);
      usdcAtomic = BigInt(info.value.amount);
    } catch {
      /* no ATA = no USDC */
    }
    // Only surface addresses that still hold something (un-swept).
    if (solLamports <= TX_FEE_LAMPORTS && usdcAtomic === 0n) continue;
    out.push({ ephemHex: announceHex.ephemHex, stealthPub: pStr, p: one.p, solLamports, usdcAtomic, sig: s.signature });
  }
  return out;
}

// ── RECIPIENT: sweep a one-time address to a wallet they control ──────────────

/**
 * Build + sign (raw scalar) the sweep transactions for one incoming payment,
 * sending everything to `destination` (a wallet the user controls). Returns the
 * serialized, signed transactions ready for sendRawTransaction.
 *
 * - USDC: [create dest ATA, transfer USDC, close P's ATA -> dest] then a 2nd tx
 *   that sweeps P's residual SOL -> dest, so NOTHING is left behind.
 * - SOL: a single transfer of (balance - fee) -> dest.
 */
export async function buildSweepTxs(input: {
  cluster: Cluster;
  incoming: IncomingPayment;
  destination: PublicKey;
}): Promise<Uint8Array[]> {
  const { cluster, incoming, destination } = input;
  const conn = getConnectionForCluster(cluster);
  const P = new PublicKey(incoming.stealthPub);
  const usdcMint = usdcMintFor(cluster);
  const txs: Uint8Array[] = [];

  const signRaw = async (ixs: TransactionInstruction[]): Promise<Uint8Array> => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: P, blockhash, lastValidBlockHeight }).add(...ixs);
    const msg = tx.serializeMessage();
    const sig = signWithStealthScalar(incoming.p, P.toBytes(), msg);
    tx.addSignature(P, Buffer.from(sig));
    return tx.serialize();
  };

  if (incoming.usdcAtomic > 0n) {
    const pAta = ataOf(P, usdcMint, TOKEN_PROGRAM);
    const { ata: destAta, ix: createDestAta } = ixCreateAtaIdempotent(P, destination, usdcMint, TOKEN_PROGRAM);
    txs.push(
      await signRaw([
        createDestAta,
        ixSplTransfer(pAta, destAta, P, incoming.usdcAtomic, TOKEN_PROGRAM),
        ixCloseAccount(pAta, destination, P, TOKEN_PROGRAM),
      ]),
    );
    // The residual SOL sweep is built lazily by the caller AFTER the USDC tx lands
    // (the post-close balance isn't known until then). See sweepResidualSol().
  } else {
    // SOL-only payment: move (balance - fee) out in one tx.
    const lamports = incoming.solLamports - TX_FEE_LAMPORTS;
    if (lamports > 0) {
      txs.push(await signRaw([SystemProgram.transfer({ fromPubkey: P, toPubkey: destination, lamports })]));
    }
  }
  return txs;
}

/** After a USDC sweep lands, move any residual SOL dust out of P -> destination. */
export async function sweepResidualSol(input: {
  cluster: Cluster;
  incoming: IncomingPayment;
  destination: PublicKey;
}): Promise<Uint8Array | null> {
  const { cluster, incoming, destination } = input;
  const conn = getConnectionForCluster(cluster);
  const P = new PublicKey(incoming.stealthPub);
  const bal = await conn.getBalance(P);
  if (bal <= TX_FEE_LAMPORTS) return null;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: P, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: P, toPubkey: destination, lamports: bal - TX_FEE_LAMPORTS }),
  );
  const msg = tx.serializeMessage();
  tx.addSignature(P, Buffer.from(signWithStealthScalar(incoming.p, P.toBytes(), msg)));
  return tx.serialize();
}

// ── display helpers ───────────────────────────────────────────────────────────
export const fmtSol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);
export const fmtUsdc = (atomic: bigint) => (Number(atomic) / 10 ** USDC_DECIMALS).toFixed(2);
export const toAtomic = (amount: number, asset: Asset): bigint =>
  asset === "SOL"
    ? BigInt(Math.floor(amount * LAMPORTS_PER_SOL))
    : BigInt(Math.floor(amount * 10 ** USDC_DECIMALS));
