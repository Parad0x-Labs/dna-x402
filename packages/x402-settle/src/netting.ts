// Lane B2 flush sink for x402/src/nettingLedger.ts. A netted charge carries
// the payer's latest cumulative voucher; a flush settles the latest voucher
// of every (payer, payee) pair in V1 Settle transactions. The netting ledger
// keeps its own accounting (provider share, facilitator fee); this program
// moves only the voucher amounts and charges no fee.

import { b58decode, b58encode, fromHex, toHex } from "./bytes.ts";
import { decodeEscrow, pairIndexFor, type Escrow } from "./accounts.ts";
import type { Signer } from "./ed25519.ts";
import { latestPerPair, packSettle, type SettleItem } from "./pack.ts";
import { escrowPda } from "./pda.ts";
import { buildV1Transaction, DEFAULT_V1_CONFIG, type V1Config } from "./v1.ts";
import type { SignedVoucher } from "./voucher.ts";

/** String form carried in a netting charge (same shape as
 * `NettingSettleVoucher` in x402/src/nettingLedger.ts). */
export interface NettingVoucher {
  payer: string;
  payee: string;
  scope: string;
  cumulativeAtomic: string;
  expirySlot: string;
  quoteHash: string;
  signature: string;
}

export function toNettingVoucher(v: SignedVoucher): NettingVoucher {
  return {
    payer: b58encode(v.payer),
    payee: b58encode(v.payee),
    scope: v.scope.toString(),
    cumulativeAtomic: v.cumulative.toString(),
    expirySlot: v.expirySlot.toString(),
    quoteHash: toHex(v.quoteHash),
    signature: toHex(v.signature),
  };
}

export interface B2FlushConfig {
  programId: Uint8Array;
  ledger: Uint8Array;
  /** Pays the transaction fees; needs no other authority. */
  feePayer: Signer;
  getAccountData(pubkey: Uint8Array): Promise<Uint8Array | null>;
  getLatestBlockhash(): Promise<Uint8Array>;
  /** Sends a serialized V1 transaction and returns its signature. */
  sendTransaction(tx: Uint8Array): Promise<string>;
  /** Book page and slot registered by the payee. */
  payeeSlot(payee: Uint8Array): Promise<{ book: Uint8Array; slot: number }>;
  v1?: V1Config;
}

export interface B2FlushSink {
  submit(vouchers: NettingVoucher[]): Promise<{ signatures: string[] }>;
  /** The settle instructions a submit would send (no network writes). */
  plan(vouchers: NettingVoucher[]): Promise<SettleItem[]>;
}

export function createB2FlushSink(cfg: B2FlushConfig): B2FlushSink {
  async function plan(vouchers: NettingVoucher[]): Promise<SettleItem[]> {
    const escrows = new Map<string, Escrow>();
    const items: SettleItem[] = [];
    for (const v of vouchers) {
      const payer = b58decode(v.payer);
      const payee = b58decode(v.payee);
      const [escrow] = escrowPda(cfg.programId, cfg.ledger, payer);
      const ek = toHex(escrow);
      let e = escrows.get(ek);
      if (!e) {
        const data = await cfg.getAccountData(escrow);
        if (!data) throw new Error(`no escrow for payer ${v.payer}`);
        e = decodeEscrow(data);
        escrows.set(ek, e);
      }
      if (e.scope.toString() !== v.scope) throw new Error(`voucher scope ${v.scope} is not the escrow scope ${e.scope}`);
      const p = pairIndexFor(e, payee);
      const cumulative = BigInt(v.cumulativeAtomic);
      if (cumulative <= p.settled) continue; // already settled on chain
      if (p.append) {
        // Reserve the index for later vouchers of this flush.
        e.pairs.push({ payee, settled: 0n, pendingCumulative: 0n, pendingBatch: 0n });
        e.pairCount += 1;
      }
      const { book, slot } = await cfg.payeeSlot(payee);
      items.push({
        escrow,
        pairIndex: p.index,
        book,
        slot,
        voucher: { cumulative, expirySlot: BigInt(v.expirySlot), quoteHash: fromHex(v.quoteHash), signature: fromHex(v.signature) },
      });
    }
    return latestPerPair(items);
  }

  return {
    plan,
    async submit(vouchers) {
      const items = await plan(vouchers);
      if (items.length === 0) return { signatures: [] };
      const ixs = packSettle(cfg.programId, cfg.ledger, cfg.feePayer.publicKey, items);
      const signatures: string[] = [];
      for (const i of ixs) {
        const tx = buildV1Transaction(cfg.feePayer, [i], await cfg.getLatestBlockhash(), [], cfg.v1 ?? DEFAULT_V1_CONFIG);
        signatures.push(await cfg.sendTransaction(tx));
      }
      return { signatures };
    },
  };
}
