// SDK flows against an in-memory RPC (no network): list parsing, commitList,
// exportProofs, entries from logs, crank, claim and verify.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildList,
  claim,
  commitList,
  crank,
  createDraw,
  decodeDraw,
  drawAddress,
  enter,
  entriesFromLogs,
  exportList,
  exportProofs,
  fromBase58,
  fromHex,
  fundPrizes,
  leafHash,
  parseList,
  toBase58,
  u64le,
  verify,
  verifyProof,
  type Rpc,
} from "../src/index.ts";

const V = JSON.parse(
  readFileSync(new URL("../../../programs/null_fair_draw/tests/vectors/fair_draw_v1.json", import.meta.url), "utf8"),
);

const PID = "FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL";

function mockRpc(accounts: Record<string, Uint8Array>, logs: Record<string, string[][]> = {}): Rpc {
  return {
    async getAccountData(k) {
      return accounts[k] ?? null;
    },
    async getLogs(k) {
      return logs[k] ?? [];
    },
  };
}

test("parseList reads CSV and JSON and rejects zero weights at build", () => {
  const w1 = toBase58(new Uint8Array(32).fill(1));
  const w2 = toBase58(new Uint8Array(32).fill(2));
  const csv = `wallet,weight\n${w1},3\n${w2}\n`;
  const a = parseList(csv);
  assert.deepEqual(a.map((e) => e.weight), [3n, 1n]);
  const b = parseList(JSON.stringify([{ wallet: w1, weight: 3 }, { wallet: w2 }]));
  assert.deepEqual(b, a);
  assert.throws(() => buildList(new Uint8Array(32), [{ wallet: a[0].wallet, weight: 0n }]), /zero-weight/);
  assert.equal(exportList(a), JSON.stringify([{ wallet: w1, weight: "3" }, { wallet: w2, weight: "1" }]));
});

test("createDraw adds Extend instructions for large draws; builders carry the right accounts", () => {
  const org = toBase58(new Uint8Array(32).fill(9));
  const params = { mode: 0, weighted: false, redrawRounds: 3, tiers: [{ count: 256, amount: 1n }], entryPrice: 0n, walletCap: 0n, closeSlot: 10_000n, claimWindowSlots: 150n };
  const r = createDraw({ programId: PID, organizer: org, drawId: 1n, params });
  assert.equal(r.instructions.length, 8);
  assert.equal(r.draw, toBase58(drawAddress(fromBase58(PID), fromBase58(org), 1n)[0]));
  const small = createDraw({ programId: PID, organizer: org, drawId: 2n, params: { ...params, tiers: [{ count: 3, amount: 1n }], redrawRounds: 2 } });
  assert.equal(small.instructions.length, 1);
  const f = fundPrizes({ programId: PID, funder: org, draw: small.draw });
  assert.equal(f.keys.length, 3);
  const e = enter({ programId: PID, payer: org, draw: small.draw, count: 2, feeDest: org });
  assert.equal(e.keys.length, 5);
  assert.equal(e.data[0], 2);
});

test("commitList and exportProofs: every published proof verifies", () => {
  const draw = new Uint8Array(32).fill(4);
  const entries = Array.from({ length: 11 }, (_, i) => ({ wallet: new Uint8Array(32).fill(i + 1), weight: BigInt(1 + (i % 4)) }));
  const { list, instruction } = commitList({ programId: PID, organizer: toBase58(new Uint8Array(32).fill(8)), draw, list: entries, weighted: true });
  assert.equal(list.depth, 4);
  assert.equal(instruction.data[0], 3);
  const proofs = exportProofs(draw, entries);
  for (const p of proofs) {
    const leaf = leafHash(draw, fromBase58(p.wallet), BigInt(p.weight));
    const start = verifyProof(list.root, list.total, list.depth, list.count, BigInt(p.index), leaf, BigInt(p.weight), fromHex(p.path));
    assert.equal(start?.toString(), p.start);
  }
  assert.throws(() => commitList({ programId: PID, organizer: toBase58(draw), draw, list: entries, weighted: false }), /weight 1/);
});

test("entries from Enter logs, only inside the program's own invocation", () => {
  const draw = new Uint8Array(32).fill(5);
  const owner = new Uint8Array(32).fill(6);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const line = (i: bigint, w: bigint) =>
    `Program data: ${[new TextEncoder().encode("entry"), u64le(i), owner, u64le(w), leafHash(draw, owner, w)].map(b64).join(" ")}`;
  const logs = [
    [`Program ${PID} invoke [1]`, line(0n, 2n), `Program ${PID} success`],
    ["Program Other111 invoke [1]", line(9n, 9n), "Program Other111 success", `Program ${PID} invoke [1]`, line(1n, 1n), `Program ${PID} success`],
  ];
  const got = entriesFromLogs(logs, PID, draw);
  assert.deepEqual(got.map((e) => e.weight), [2n, 1n]);
});

test("verify, crank and claim against the fixture through an RPC", async () => {
  const f = V.verify;
  const drawKey = toBase58(fromHex(f.draw));
  const entries = f.entries.map((x: any) => ({ wallet: fromHex(x.wallet), weight: BigInt(x.weight) }));
  const rpc = mockRpc({ [drawKey]: fromHex(f.hex) });
  const r = await verify(rpc, { programId: PID, draw: drawKey, entries });
  assert.ok(r.ok, r.problems.join("; "));
  assert.equal(r.winners.length, 4);
  // Committed lists need the published list.
  await assert.rejects(verify(rpc, { programId: PID, draw: drawKey }), /published list/);
  // Round 1 is fully resolved: the next crank is Advance.
  const c = await crank(rpc, { programId: PID, draw: drawKey, entries });
  assert.equal(c.step, "advance");
  // The round-1 winner (slot 3) can claim; slot 2 was forfeited.
  const d = decodeDraw(fromHex(f.hex));
  const w3 = toBase58(d.slots[3].wallet);
  const ix = await claim(rpc, { programId: PID, draw: drawKey, winner: w3, slot: 3, entries });
  assert.equal(ix.data.length, 4); // weighted slot: no proof needed
  await assert.rejects(claim(rpc, { programId: PID, draw: drawKey, winner: w3, slot: 2, entries }), /not claimable/);
  // A draw with a pending weighted slot cranks Resolve with the right proof.
  const bytes = fromHex(f.hex);
  const nextSlotOff = 392 + 4; // capacity, slot_count, next_slot
  bytes[nextSlotOff] = 3;
  const rpc2 = mockRpc({ [drawKey]: bytes });
  const c2 = await crank(rpc2, { programId: PID, draw: drawKey, entries });
  assert.equal(c2.step, "resolve");
  assert.equal(c2.instructions[0].data[2], 1); // one proof
});

test("verify.html inlines the current core and the inlined code verifies the fixture", async () => {
  const { render, coreJs } = await import("../scripts/build-verify-page.mjs");
  const html = readFileSync(new URL("../verify.html", import.meta.url), "utf8");
  assert.equal(html, render(html), "verify.html is stale: run npm run build:verify");
  assert.match(html, /integrity="sha256-[A-Za-z0-9+/]{43}="/);
  // Run the stripped core as plain JavaScript (as the browser does).
  const fn = new Function(`${coreJs()}\nreturn { decodeDraw, verifyDrawState, fromHex };`);
  const c = fn();
  const f = V.verify;
  const entries = f.entries.map((x: any) => ({ wallet: c.fromHex(x.wallet), weight: BigInt(x.weight) }));
  const r = c.verifyDrawState(c.fromHex(f.draw), c.decodeDraw(c.fromHex(f.hex)), entries);
  assert.ok(r.ok, r.problems.join("; "));
});
