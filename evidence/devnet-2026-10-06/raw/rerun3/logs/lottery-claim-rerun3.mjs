// dark_null_lottery rerun 3 (after the FallbackDraw winner-binding upgrade, dna-x402 7439dde).
// Part A (rerun 2 cases): one round, drawn-numbers winner. Part B: three consecutive Drawn rounds
// -> FallbackDraw -> claims. Every outcome is read from the ledger.
import { PublicKey, TransactionInstruction, SystemProgram, Keypair } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes, createHash } from "node:crypto";
import { conn, payer, send, finish, saveKp, sleep, results } from "./lib.mjs";

const P = new PublicKey(process.env.PROGRAM);
const sys = { pubkey: SystemProgram.programId, isSigner: false, isWritable: false };
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const w = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const sha = (...p) => createHash("sha256").update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();
const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("lottery-config")], P);
const roundPda = (id) => PublicKey.findProgramAddressSync([Buffer.from("round"), u64(id)], P)[0];
const claimPda = (n) => PublicKey.findProgramAddressSync([Buffer.from("claim"), n], P)[0];

// processor::draw_numbers: keccak256(seed || round_id_le || [i]) Fisher-Yates over 1..=30.
function drawNumbers(seed, rid) {
  const pool = Array.from({ length: 30 }, (_, i) => i + 1); const out = [];
  for (let i = 0; i < 5; i++) {
    const rem = 30 - i;
    const h = Buffer.from(keccak_256(Buffer.concat([seed, u64(rid), Buffer.from([i])])));
    const idx = Number(h.readBigUInt64LE(0) % BigInt(rem));
    out.push(pool[idx]); pool[idx] = pool[rem - 1];
  }
  return out;
}
// ticket.rs
const TAG = Buffer.from("dark-null-lottery:ticket:v1");
const leafOf = (rid, owner, nums, nul) => sha(TAG, u64(rid), owner.toBuffer(), Buffer.from(nums), nul);
const node = (l, r) => sha(Buffer.from([1]), l, r);
const nextLevel = (lv) => { const o = []; for (let i = 0; i < lv.length; i += 2) o.push(node(lv[i], lv[i + 1] ?? lv[i])); return o; };
const rootOf = (leaves) => { let lv = leaves; while (lv.length > 1) lv = nextLevel(lv); return lv[0]; };
const proofOf = (leaves, index) => { const pr = []; let lv = leaves, i = index; while (lv.length > 1) { pr.push(lv[i ^ 1] ?? lv[lv.length - 1]); lv = nextLevel(lv); i >>= 1; } return pr; };
// ticket::fallback_winner_index
const fallbackIndex = (seed, rid, count) => Number(sha(Buffer.from("dark-null-lottery:fallback:v1"), seed, u64(rid)).readBigUInt64LE(0) % BigInt(count));
// The removed path: old FallbackDraw winner nullifier SHA-256(seed || "fallback" || idx), idx = keccak(seed || pool_size_le) mod pool_size.
const oldSyntheticNullifier = (seed, pool) => {
  const idx = Buffer.from(keccak_256(Buffer.concat([seed, u64(pool)]))).readBigUInt64LE(0) % BigInt(pool);
  return sha(seed, Buffer.from("fallback"), u64(idx));
};

const claimIx = (claimant, nul, ticket /* {numbers,index,proof} | null */, R) => new TransactionInstruction({
  programId: P,
  keys: [w(R), w(claimPda(nul)), { pubkey: claimant.publicKey, isSigner: true, isWritable: true }, ro(SystemProgram.programId), ro(SystemProgram.programId),
    ro(SystemProgram.programId), ro(SystemProgram.programId), sys],
  data: Buffer.concat([Buffer.from([0x06]), nul, ...(ticket ? [Buffer.from(ticket.numbers), u64(ticket.index), Buffer.from([ticket.proof.length]), ...ticket.proof] : [])]),
});
const commitIx = (rid, commitment) => new TransactionInstruction({ programId: P, keys: [w(cfg), w(roundPda(rid)), { pubkey: payer.publicKey, isSigner: true, isWritable: true }, sys], data: Buffer.concat([Buffer.from([0x02]), commitment]) });
const anchorIx = (rid, root, count) => new TransactionInstruction({ programId: P, keys: [w(roundPda(rid)), { pubkey: payer.publicKey, isSigner: true, isWritable: false }, ro(cfg)], data: Buffer.concat([Buffer.from([0x03]), root, u64(count), u64(0)]) });
const revealIx = (rid, seed) => new TransactionInstruction({ programId: P, keys: [w(roundPda(rid)), { pubkey: payer.publicKey, isSigner: true, isWritable: false }, ro(cfg)], data: Buffer.concat([Buffer.from([0x04]), seed]) });
const fallbackIx = (admin, rounds, seed, root, size) => new TransactionInstruction({
  programId: P,
  keys: [ro(cfg), w(rounds[0]), w(rounds[1]), w(rounds[2]), { pubkey: admin, isSigner: true, isWritable: false }],
  data: Buffer.concat([Buffer.from([0x05]), seed, root, u64(size)]),
});
const roundAcct = async (rid) => { await sleep(1200); return (await conn.getAccountInfo(roundPda(rid))).data; };
const check = (label, ok, extra = {}) => { results.push({ label, expected: "ledger state", pass: ok, ...extra }); console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`); };
const nextRoundId = async () => Number((await conn.getAccountInfo(cfg)).data.readBigUInt64LE(46));

// Accounts
const loser = Keypair.generate(); saveKp("lottery-rerun3-loser", loser);
const attacker = Keypair.generate(); saveKp("lottery-rerun3-attacker", attacker);
await send("fund loser + attacker 0.01 SOL each", [
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: loser.publicKey, lamports: 10_000_000 }),
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker.publicKey, lamports: 10_000_000 })], [], "ok");

// ── Part A: drawn-numbers winner (rerun 2 cases) ──────────────────────────────
const rid = await nextRoundId();
const R = roundPda(rid);
const seed = randomBytes(32);
await send(`A CommitRound id=${rid}`, [commitIx(rid, sha(seed))], [], "ok");
const drawn = drawNumbers(seed, rid).sort((a, b) => a - b);
const spare = Array.from({ length: 30 }, (_, i) => i + 1).find((n) => !drawn.includes(n));
const lose = [spare, ...drawn.slice(1)].sort((a, b) => a - b);
const tickets = [
  { owner: loser.publicKey, numbers: lose, nul: randomBytes(32) },
  { owner: attacker.publicKey, numbers: lose, nul: randomBytes(32) },
  { owner: payer.publicKey, numbers: drawn, nul: randomBytes(32) },
  { owner: loser.publicKey, numbers: lose, nul: randomBytes(32) },
  { owner: attacker.publicKey, numbers: lose, nul: randomBytes(32) },
];
const leaves = tickets.map((t) => leafOf(rid, t.owner, t.numbers, t.nul));
const root = rootOf(leaves);
await send("A AnchorTickets (5-ticket SHA-256 tickets tree)", [anchorIx(rid, root, tickets.length)], [], "ok");
await send("A RevealDraw (committed seed) -> Drawn", [revealIx(rid, seed)], [], "ok");
let rs = await roundAcct(rid);
const onchainDrawn = [...rs.subarray(121, 126)].sort((a, b) => a - b);
check("A on-chain drawn numbers == draw_numbers(seed, round_id); status Drawn", JSON.stringify(onchainDrawn) === JSON.stringify(drawn) && rs[126] === 3, { onchain: onchainDrawn, status: rs[126] });

const t = (i, numbers = tickets[i].numbers) => ({ numbers, index: i, proof: proofOf(leaves, i) });
await send("A ATTACK nullifier-only claim on Drawn round -> InvalidTicketProof (0x600B)", [claimIx(attacker, randomBytes(32), null, R)], [attacker], { custom: 0x600B }, attacker);
await send("A ATTACK anchored LOSING ticket (valid proof) -> TicketNotWinning (0x600A)", [claimIx(loser, tickets[0].nul, t(0), R)], [loser], { custom: 0x600A }, loser);
await send("A ATTACK own ticket relabelled with the drawn numbers -> InvalidTicketProof (0x600B)", [claimIx(attacker, tickets[1].nul, t(1, drawn), R)], [attacker], { custom: 0x600B }, attacker);
await send("A ATTACK front-run: winner's ticket + proof signed by attacker -> InvalidTicketProof (0x600B)", [claimIx(attacker, tickets[2].nul, t(2), R)], [attacker], { custom: 0x600B }, attacker);
await send("A Winner (ticket owner) claims with numbers + proof -> Won", [claimIx(payer, tickets[2].nul, t(2), R)], [], "ok");
rs = await roundAcct(rid);
check("A round status Won, winner_nullifier = winning ticket nullifier", rs[126] === 4 && Buffer.from(rs.subarray(127, 159)).equals(tickets[2].nul), { status: rs[126] });
await send("A ATTACK second claim of the same ticket -> AlreadyClaimed (0x6005)", [claimIx(payer, tickets[2].nul, t(2), R)], [], { custom: 0x6005 });

// ── Part B: FallbackDraw over three consecutive Drawn rounds ──────────────────
const b0 = await nextRoundId();
const ids = [b0, b0 + 1, b0 + 2];
const RB = ids.map(roundPda);
const seeds = ids.map(() => randomBytes(32));
const POOL = 5;
// Rounds 1 and 2: one ticket each with that round's drawn numbers (never claimed).
const early = [];
for (let k = 0; k < 2; k++) {
  const id = ids[k];
  await send(`B CommitRound id=${id}`, [commitIx(id, sha(seeds[k]))], [], "ok");
  const tk = { owner: loser.publicKey, numbers: drawNumbers(seeds[k], id).sort((a, b) => a - b), nul: randomBytes(32) };
  await send(`B AnchorTickets id=${id} (1 ticket)`, [anchorIx(id, leafOf(id, tk.owner, tk.numbers, tk.nul), 1)], [], "ok");
  await send(`B RevealDraw id=${id} -> Drawn`, [revealIx(id, seeds[k])], [], "ok");
  early.push(tk);
}
// Round 3: the fallback pool. The selected ticket is the payer's; `other` carries the drawn numbers.
const c = ids[2], sC = seeds[2];
await send(`B CommitRound id=${c} (fallback pool round)`, [commitIx(c, sha(sC))], [], "ok");
const sel = fallbackIndex(sC, c, POOL), other = (sel + 1) % POOL;
const drawnC = drawNumbers(sC, c).sort((a, b) => a - b);
const spareC = Array.from({ length: 30 }, (_, i) => i + 1).find((n) => !drawnC.includes(n));
const loseC = [spareC, ...drawnC.slice(1)].sort((a, b) => a - b);
const pool = Array.from({ length: POOL }, (_, i) => i === sel ? { owner: payer.publicKey, numbers: loseC, nul: randomBytes(32) }
  : i === other ? { owner: loser.publicKey, numbers: drawnC, nul: randomBytes(32) }
  : { owner: attacker.publicKey, numbers: loseC, nul: randomBytes(32) });
const leavesC = pool.map((x) => leafOf(c, x.owner, x.numbers, x.nul));
const rootC = rootOf(leavesC);
await send(`B AnchorTickets id=${c} (5-ticket tree; selected index ${sel})`, [anchorIx(c, rootC, POOL)], [], "ok");
await send(`B RevealDraw id=${c} -> Drawn`, [revealIx(c, sC)], [], "ok");

await send("B ATTACK FallbackDraw by non-admin -> NotAdmin (0x6008)", [fallbackIx(attacker.publicKey, RB, sC, rootC, POOL)], [attacker], { custom: 0x6008 }, attacker);
await send("B ATTACK FallbackDraw with a fresh (uncommitted) seed -> InvalidSeed (0x6004)", [fallbackIx(payer.publicKey, RB, randomBytes(32), rootC, POOL)], [], { custom: 0x6004 });
await send("B ATTACK FallbackDraw with another round's seed -> InvalidSeed (0x6004)", [fallbackIx(payer.publicKey, RB, seeds[1], rootC, POOL)], [], { custom: 0x6004 });
await send("B ATTACK FallbackDraw with a pool root that is not the anchored tree -> FallbackPoolMismatch (0x600C)", [fallbackIx(payer.publicKey, RB, sC, randomBytes(32), POOL)], [], { custom: 0x600C });
await send("B ATTACK FallbackDraw with a different pool size -> FallbackPoolMismatch (0x600C)", [fallbackIx(payer.publicKey, RB, sC, rootC, POOL + 7)], [], { custom: 0x600C });
await send("B ATTACK FallbackDraw rounds out of order -> FallbackRoundsNotConsecutive (0x600E)", [fallbackIx(payer.publicKey, [RB[0], RB[2], RB[1]], sC, rootC, POOL)], [], { custom: 0x600E });
const before = await Promise.all(ids.map(async (id) => (await roundAcct(id))[126]));
check("B all three rounds still Drawn after the rejected FallbackDraws", before.every((s) => s === 3), { statuses: before });

await send("B FallbackDraw (admin, committed seed, anchored pool)", [fallbackIx(payer.publicKey, RB, sC, rootC, POOL)], [], "ok");
const after = await Promise.all(ids.map(async (id) => await roundAcct(id)));
check("B statuses NoWinner, NoWinner, FallbackDrawn; no winner recorded", after[0][126] === 5 && after[1][126] === 5 && after[2][126] === 6 && after[2].subarray(127, 159).every((x) => x === 0), { statuses: after.map((d) => d[126]) });

const tc = (i) => ({ numbers: pool[i].numbers, index: i, proof: proofOf(leavesC, i) });
const synthetic = oldSyntheticNullifier(sC, POOL);
await send("B ATTACK old synthetic fallback nullifier, no ticket -> InvalidTicketProof (0x600B)", [claimIx(attacker, synthetic, null, RB[2])], [attacker], { custom: 0x600B }, attacker);
await send("B ATTACK selected ticket's nullifier, no ticket -> InvalidTicketProof (0x600B)", [claimIx(attacker, pool[sel].nul, null, RB[2])], [attacker], { custom: 0x600B }, attacker);
await send("B ATTACK unselected ticket with the drawn numbers, owner signs, valid proof -> NotFallbackWinner (0x600D)", [claimIx(loser, pool[other].nul, tc(other), RB[2])], [loser], { custom: 0x600D }, loser);
await send("B ATTACK copied selected ticket + proof under another claimant -> InvalidTicketProof (0x600B)", [claimIx(attacker, pool[sel].nul, tc(sel), RB[2])], [attacker], { custom: 0x600B }, attacker);
await send("B Selected ticket owner claims with leaf + proof -> Won", [claimIx(payer, pool[sel].nul, tc(sel), RB[2])], [], "ok");
const won = await roundAcct(c);
check("B fallback round Won, winner_nullifier = selected ticket nullifier", won[126] === 4 && Buffer.from(won.subarray(127, 159)).equals(pool[sel].nul), { status: won[126] });
await send("B ATTACK second claim of the selected ticket -> AlreadyClaimed (0x6005)", [claimIx(payer, pool[sel].nul, tc(sel), RB[2])], [], { custom: 0x6005 });
await send("B ATTACK claim on a NoWinner round with its drawn-numbers ticket -> WrongStatus (0x6007)", [claimIx(loser, early[0].nul, { numbers: early[0].numbers, index: 0, proof: [] }, RB[0])], [loser], { custom: 0x6007 }, loser);
await send("B ATTACK FallbackDraw again on the same rounds -> WrongStatus (0x6007)", [fallbackIx(payer.publicKey, RB, sC, rootC, POOL)], [], { custom: 0x6007 });

for (const [tag, kp] of [["loser", loser], ["attacker", attacker]]) {
  await sleep(800);
  const bal = await conn.getBalance(kp.publicKey);
  if (bal > 5000) await send(`sweep ${tag} back to payer`, [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: payer.publicKey, lamports: bal - 5000 })], [kp], "ok", kp);
}
finish("probe-lottery-claim-rerun3", {
  program: P.toBase58(), cfg: cfg.toBase58(),
  drawnRound: { id: rid, pda: R.toBase58(), ticketsRoot: root.toString("hex"), ticketCount: tickets.length, drawn, winnerIndex: 2, winnerNullifier: tickets[2].nul.toString("hex") },
  fallback: { rounds: ids, pdas: RB.map((k) => k.toBase58()), poolRoot: rootC.toString("hex"), poolSize: POOL, selectedIndex: sel, unselectedDrawnNumbersIndex: other, drawn: drawnC, winnerNullifier: pool[sel].nul.toString("hex"), oldSyntheticNullifier: synthetic.toString("hex") },
});
