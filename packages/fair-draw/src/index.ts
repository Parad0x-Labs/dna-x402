// @parad0x_labs/fair-draw: client SDK for the null_fair_draw Solana program.
//
// The SDK has no runtime dependencies. Instruction builders return plain
// instructions (`programId`, `keys`, `data`) that `toWeb3Instruction` turns
// into @solana/web3.js TransactionInstructions with the web3 module you pass
// in. Reads use a minimal JSON-RPC client (`jsonRpc(url)`) or any object with
// the same two methods. Program ids are not hardcoded: pass yours.

import * as core from "./core.ts";
import {
  type BuiltList,
  type CreateParams,
  type DrawAccount,
  type Entry,
  type LeafProof,
  STATUS,
  SLOT_STATUS,
  MODE_LIST,
  buildList,
  decodeDraw,
  drawAddress,
  entrantAddress,
  key,
  leafAt,
  listProof,
  parseList,
  point,
  proofFromLevels,
  remap,
  toBase58,
  toHex,
  vaultAddress,
  verifyDrawState,
} from "./core.ts";

export * from "./core.ts";

export type Key = string | Uint8Array;

export interface AccountMetaLike {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Ix {
  programId: string;
  keys: AccountMetaLike[];
  data: Uint8Array;
}

const b58 = (k: Key): string => (typeof k === "string" ? k : toBase58(k));
const meta = (k: Key, isSigner: boolean, isWritable: boolean): AccountMetaLike => ({ pubkey: b58(k), isSigner, isWritable });
const ZERO32 = new Uint8Array(32);
const isSpl = (mint?: Uint8Array) => mint !== undefined && !core.equalBytes(mint, ZERO32);

/** Convert to a web3.js TransactionInstruction (pass the @solana/web3.js module). */
export function toWeb3Instruction(ix: Ix, web3: { PublicKey: new (k: string) => unknown; TransactionInstruction: new (o: unknown) => unknown }): unknown {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(ix.programId),
    keys: ix.keys.map((k) => ({ pubkey: new web3.PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: ix.data,
  });
}

// ── RPC ─────────────────────────────────────────────────────────────────────

export interface Rpc {
  /** Raw account data, or null if the account does not exist. */
  getAccountData(pubkey: string): Promise<Uint8Array | null>;
  /** Log lines of every transaction that touched `pubkey`, oldest to newest. */
  getLogs(pubkey: string): Promise<string[][]>;
  getSlot?(): Promise<bigint>;
}

/** Minimal JSON-RPC client over fetch. */
export function jsonRpc(url: string): Rpc {
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<any> => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  return {
    async getAccountData(pubkey) {
      const res = await call("getAccountInfo", [pubkey, { encoding: "base64", commitment: "confirmed" }]);
      if (!res?.value) return null;
      return Uint8Array.from(atob(res.value.data[0]), (c) => c.charCodeAt(0));
    },
    async getLogs(pubkey) {
      const sigs: string[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await call("getSignaturesForAddress", [pubkey, { limit: 1000, before, commitment: "confirmed" }]);
        for (const s of page) if (!s.err) sigs.push(s.signature);
        if (page.length < 1000) break;
        before = page[page.length - 1].signature;
      }
      const out: string[][] = [];
      for (const sig of sigs.reverse()) {
        const tx = await call("getTransaction", [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
        out.push(tx?.meta?.logMessages ?? []);
      }
      return out;
    },
    async getSlot() {
      return BigInt(await call("getSlot", [{ commitment: "confirmed" }]));
    },
  };
}

export async function fetchDraw(rpc: Rpc, draw: Key): Promise<DrawAccount> {
  const data = await rpc.getAccountData(b58(draw));
  if (!data) throw new Error("draw account not found");
  return decodeDraw(data);
}

// ── instruction builders ────────────────────────────────────────────────────

export interface CreateDrawArgs {
  programId: Key;
  organizer: Key;
  drawId: bigint;
  params: CreateParams;
}

/** CreateDraw (plus the Extend instructions a large draw needs). */
export function createDraw(a: CreateDrawArgs): { draw: string; vault?: string; instructions: Ix[] } {
  const pid = key(a.programId);
  const [draw] = drawAddress(pid, key(a.organizer), a.drawId);
  const keys = [meta(a.organizer, true, true), meta(draw, false, true), meta(core.SYSTEM_PROGRAM_ID, false, false)];
  let vault: string | undefined;
  if (isSpl(a.params.prizeMint)) {
    vault = toBase58(vaultAddress(pid, draw)[0]);
    keys.push(meta(vault, false, true), meta(a.params.prizeMint!, false, false), meta(core.TOKEN_PROGRAM_ID, false, false));
  }
  const instructions: Ix[] = [{ programId: b58(pid), keys, data: core.encodeCreateDraw(a.drawId, a.params) }];
  const prizes = a.params.tiers.reduce((s, t) => s + t.count, 0);
  const full = core.drawLen(a.params.mode, prizes * (1 + a.params.redrawRounds));
  for (let have = Math.min(full, core.MAX_ALLOC_STEP); have < full; have += core.MAX_ALLOC_STEP) {
    instructions.push({
      programId: b58(pid),
      keys: [meta(a.organizer, true, true), meta(draw, false, true), meta(core.SYSTEM_PROGRAM_ID, false, false)],
      data: core.encodeExtend(),
    });
  }
  return { draw: toBase58(draw), vault, instructions };
}

/** Escrow every prize (SPL: pass the funder's prize-mint token account). */
export function fundPrizes(a: { programId: Key; funder: Key; draw: Key; funderToken?: Key }): Ix {
  const pid = key(a.programId);
  const keys = [meta(a.funder, true, true), meta(a.draw, false, true), meta(core.SYSTEM_PROGRAM_ID, false, false)];
  if (a.funderToken) {
    keys.push(meta(a.funderToken, false, true), meta(vaultAddress(pid, key(a.draw))[0], false, true), meta(core.TOKEN_PROGRAM_ID, false, false));
  }
  return { programId: b58(pid), keys, data: core.encodeFundPrizes() };
}

/** Enter an open raffle. `count` entries (weighted: one leaf of weight count). */
export function enter(a: { programId: Key; payer: Key; draw: Key; owner?: Key; count: number; feeDest: Key; payerToken?: Key }): Ix {
  const pid = key(a.programId);
  const owner = key(a.owner ?? a.payer);
  const keys = [
    meta(a.payer, true, true),
    meta(a.draw, false, true),
    meta(core.SYSTEM_PROGRAM_ID, false, false),
    meta(entrantAddress(pid, key(a.draw), owner)[0], false, true),
    meta(a.feeDest, false, true),
  ];
  if (a.payerToken) keys.push(meta(a.payerToken, false, true), meta(core.TOKEN_PROGRAM_ID, false, false));
  return { programId: b58(pid), keys, data: core.encodeEnter(a.count, owner) };
}

/**
 * Build the committed list from CSV or JSON text (or entries) and the
 * CommitList instruction. Publish `list.entries` (for example with
 * `exportList`) so anyone can rebuild the root.
 */
export function commitList(a: { programId: Key; organizer: Key; draw: Key; list: string | Entry[]; weighted: boolean }): { instruction: Ix; list: BuiltList } {
  const entries = typeof a.list === "string" ? parseList(a.list) : a.list;
  if (!a.weighted && entries.some((e) => e.weight !== 1n)) throw new Error("unweighted draws take weight 1 for every entry");
  const list = buildList(key(a.draw), entries);
  return {
    list,
    instruction: {
      programId: b58(a.programId),
      keys: [meta(a.organizer, true, false), meta(a.draw, false, true)],
      data: core.encodeCommitList(list.root, list.total, list.count, list.depth),
    },
  };
}

/** The list as JSON text (`[{ wallet, weight }]`), for publishing. */
export function exportList(entries: Entry[]): string {
  return JSON.stringify(entries.map((e) => ({ wallet: toBase58(e.wallet), weight: e.weight.toString() })));
}

/** Every entry's proof (for publishing next to the list). */
export function exportProofs(draw: Key, entries: Entry[], depth?: number): { index: number; wallet: string; weight: string; start: string; path: string }[] {
  const list = buildList(key(draw), entries, depth);
  let start = 0n;
  return list.entries.map((e, i) => {
    const r = { index: i, wallet: toBase58(e.wallet), weight: e.weight.toString(), start: start.toString(), path: toHex(proofFromLevels(list.levels, list.depth, i)) };
    start += e.weight;
    return r;
  });
}

async function entriesFor(rpc: Rpc, programId: Key, draw: Key, a: DrawAccount, entries?: Entry[] | string): Promise<Entry[]> {
  if (entries !== undefined) return typeof entries === "string" ? parseList(entries) : entries;
  if (a.mode === MODE_LIST) throw new Error("a committed-list draw needs its published list");
  return core.entriesFromLogs(await rpc.getLogs(b58(draw)), b58(programId), key(draw));
}

/**
 * The next permissionless instructions for a draw: Draw when the current
 * round waits for its slot hash, Resolve (a batch of up to 24 unweighted
 * slots, or one weighted slot with its proof) while slots are pending, and
 * Advance after the claim window. Call repeatedly; every cranker gets the
 * same result.
 */
export async function crank(rpc: Rpc, a: { programId: Key; draw: Key; entries?: Entry[] | string }): Promise<{ step: string; instructions: Ix[] }> {
  const pid = b58(a.programId);
  const d = await fetchDraw(rpc, a.draw);
  const w = [meta(a.draw, false, true)];
  if (d.status === STATUS.awaitDraw || (d.status === STATUS.funded && d.mode === core.MODE_OPEN)) {
    return { step: "draw", instructions: [{ programId: pid, keys: [...w, meta(core.SLOT_HASHES_SYSVAR, false, false)], data: core.encodeDraw() }] };
  }
  if (d.status !== STATUS.resolving) return { step: "none", instructions: [] };
  if (d.nextSlot < d.slotCount) {
    if (!d.weighted) return { step: "resolve", instructions: [{ programId: pid, keys: w, data: core.encodeResolve(24, []) }] };
    const remaining = d.totalWeight - d.wonWeight;
    if (remaining === 0n) return { step: "resolve", instructions: [{ programId: pid, keys: w, data: core.encodeResolve(1, []) }] };
    const list = buildList(key(a.draw), await entriesFor(rpc, a.programId, a.draw, d, a.entries), d.depth);
    const p = remap(point(d.rounds[d.round].seed, BigInt(d.nextSlot), remaining), d.won);
    const proof = listProof(list, leafAt(list, p));
    return { step: "resolve", instructions: [{ programId: pid, keys: w, data: core.encodeResolve(1, [proof]) }] };
  }
  return { step: "advance", instructions: [{ programId: pid, keys: w, data: core.encodeAdvance() }] };
}

/** Claim instruction for `winner`'s slot (adds the proof when the slot needs one). */
export async function claim(
  rpc: Rpc,
  a: { programId: Key; draw: Key; winner: Key; slot: number; entries?: Entry[] | string; winnerToken?: Key },
): Promise<Ix> {
  const pid = key(a.programId);
  const d = await fetchDraw(rpc, a.draw);
  const s = d.slots[a.slot];
  if (!s || s.status !== SLOT_STATUS.won) throw new Error(`slot ${a.slot} is not claimable`);
  let proof: LeafProof | undefined;
  if (core.equalBytes(s.wallet, ZERO32)) {
    const list = buildList(key(a.draw), await entriesFor(rpc, a.programId, a.draw, d, a.entries), d.depth);
    proof = listProof(list, Number(s.leafIndex));
    if (!core.equalBytes(proof.wallet, key(a.winner))) throw new Error("this slot's leaf belongs to another wallet");
  } else if (!core.equalBytes(s.wallet, key(a.winner))) {
    throw new Error("this slot belongs to another wallet");
  }
  const keys = [meta(a.winner, true, true), meta(a.draw, false, true)];
  if (a.winnerToken) {
    keys.push(meta(a.winnerToken, false, true), meta(vaultAddress(pid, key(a.draw))[0], false, true), meta(core.TOKEN_PROGRAM_ID, false, false));
  }
  return { programId: b58(pid), keys, data: core.encodeClaim(a.slot, proof) };
}

/**
 * Recompute a draw from public data and check it against the chain: the
 * entry root and total, every round's seed from its recorded slot hash and
 * the fixed fallback schedule, every winner (slot order, re-draws included)
 * and every winner's proof. Open raffles rebuild their entries from the
 * Enter logs; committed lists need the published list.
 */
export async function verify(
  rpc: Rpc,
  a: { programId: Key; draw: Key; entries?: Entry[] | string },
): Promise<core.VerifyReport & { draw: DrawAccount }> {
  const d = await fetchDraw(rpc, a.draw);
  const entries = d.leafCount === 0n ? [] : await entriesFor(rpc, a.programId, a.draw, d, a.entries);
  return { ...verifyDrawState(key(a.draw), d, entries), draw: d };
}
