/**
 * Bilateral netting for x402 payment receipt batches.
 *
 * Instead of anchoring every individual receipt, net the flows between
 * each (sender, receiver) pair. If agent A paid B $0.50 total and B paid
 * A $0.20 total, the net settlement is A owes B $0.30. One record, not N.
 *
 * This reduces anchor volume proportionally to how much agents trade back
 * and forth — the more interconnected the agent network, the bigger the saving.
 */

import type { X402Receipt } from "./compress.js";

export interface NetSettlement {
  sender:       string;
  receiver:     string;
  netAmount:    bigint;   // positive = sender owes receiver
  receiptCount: number;
  firstAt:      number;
  lastAt:       number;
  receiptIds:   string[];
}

/**
 * Net a batch of receipts into bilateral settlements.
 * Returns one entry per (sender, receiver) pair with a net positive balance.
 * Pairs that net to zero are dropped.
 */
export function netReceipts(receipts: X402Receipt[]): NetSettlement[] {
  // Accumulate gross flows: key = "sender|receiver"
  const flows = new Map<string, {
    gross: bigint;
    count: number;
    firstAt: number;
    lastAt: number;
    ids: string[];
  }>();

  for (const r of receipts) {
    const key = `${r.sender}|${r.receiver}`;
    const existing = flows.get(key) ?? { gross: 0n, count: 0, firstAt: r.timestamp, lastAt: r.timestamp, ids: [] };
    existing.gross  += BigInt(r.amount ?? 0);
    existing.count  += 1;
    existing.firstAt = Math.min(existing.firstAt, r.timestamp);
    existing.lastAt  = Math.max(existing.lastAt,  r.timestamp);
    if (r.receiptId) existing.ids.push(r.receiptId);
    flows.set(key, existing);
  }

  // Net bilateral pairs: for each A→B, find B→A and cancel
  const settled = new Map<string, NetSettlement>();
  const seen    = new Set<string>();

  for (const [key, fwd] of flows) {
    if (seen.has(key)) continue;
    const [a, b] = key.split("|");
    const revKey  = `${b}|${a}`;
    const rev     = flows.get(revKey);

    const netFwd  = fwd.gross - (rev?.gross ?? 0n);
    seen.add(key);
    if (rev) seen.add(revKey);

    if (netFwd > 0n) {
      settled.set(key, {
        sender: a, receiver: b,
        netAmount: netFwd,
        receiptCount: fwd.count + (rev?.count ?? 0),
        firstAt: Math.min(fwd.firstAt, rev?.firstAt ?? fwd.firstAt),
        lastAt:  Math.max(fwd.lastAt,  rev?.lastAt  ?? fwd.lastAt),
        receiptIds: [...fwd.ids, ...(rev?.ids ?? [])],
      });
    } else if (netFwd < 0n) {
      settled.set(revKey, {
        sender: b, receiver: a,
        netAmount: -netFwd,
        receiptCount: fwd.count + (rev?.count ?? 0),
        firstAt: Math.min(fwd.firstAt, rev?.firstAt ?? fwd.firstAt),
        lastAt:  Math.max(fwd.lastAt,  rev?.lastAt  ?? fwd.lastAt),
        receiptIds: [...fwd.ids, ...(rev?.ids ?? [])],
      });
    }
    // netFwd === 0n → fully cancelled, drop
  }
  return [...settled.values()];
}
