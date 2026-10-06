// dark_null_lottery rerun 2 (after the ClaimJackpot winner-binding upgrade, dna-x402 a32933d).
// One round: commit -> anchor a 5-ticket SHA-256 tickets tree (ticket 2 = drawn numbers,
// owned by the payer) -> reveal -> claims. Every outcome is read from the ledger.
import { PublicKey, TransactionInstruction, SystemProgram, Keypair } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes, createHash } from "node:crypto";
import { conn, payer, send, finish, saveKp, sleep, results } from "./lib.mjs";

const P = new PublicKey(process.env.PROGRAM);
const sys = { pubkey: SystemProgram.programId, isSigner: false, isWritable: false };
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
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

const claimIx = (claimant, nul, ticket /* {numbers,index,proof} | null */, R) => new TransactionInstruction({
  programId: P,
  keys: [{ pubkey: R, isSigner: false, isWritable: true }, { pubkey: claimPda(nul), isSigner: false, isWritable: true },
    { pubkey: claimant.publicKey, isSigner: true, isWritable: true }, ro(SystemProgram.programId), ro(SystemProgram.programId),
    ro(SystemProgram.programId), ro(SystemProgram.programId), sys],
  data: Buffer.concat([Buffer.from([0x06]), nul, ...(ticket ? [Buffer.from(ticket.numbers), u64(ticket.index), Buffer.from([ticket.proof.length]), ...ticket.proof] : [])]),
});

// Accounts
const loser = Keypair.generate(); saveKp("lottery-rerun2-loser", loser);
const attacker = Keypair.generate(); saveKp("lottery-rerun2-attacker", attacker);
await send("fund loser + attacker 0.01 SOL each", [
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: loser.publicKey, lamports: 10_000_000 }),
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker.publicKey, lamports: 10_000_000 })], [], "ok");

// Round
const cfgInfo = await conn.getAccountInfo(cfg);
const rid = Number(cfgInfo.data.readBigUInt64LE(46));
const R = roundPda(rid);
const seed = randomBytes(32), commitment = sha(seed);
await send(`CommitRound id=${rid}`, [new TransactionInstruction({ programId: P, keys: [{ pubkey: cfg, isSigner: false, isWritable: true }, { pubkey: R, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }, sys], data: Buffer.concat([Buffer.from([0x02]), commitment]) })], [], "ok");

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
await send("AnchorTickets (5-ticket SHA-256 tickets tree)", [new TransactionInstruction({ programId: P, keys: [{ pubkey: R, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }, ro(cfg)], data: Buffer.concat([Buffer.from([0x03]), root, u64(tickets.length), u64(0)]) })], [], "ok");
await send("RevealDraw (committed seed) -> Drawn", [new TransactionInstruction({ programId: P, keys: [{ pubkey: R, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }, ro(cfg)], data: Buffer.concat([Buffer.from([0x04]), seed]) })], [], "ok");
await sleep(1500);
const rs = (await conn.getAccountInfo(R)).data;
const onchainDrawn = [...rs.subarray(121, 126)].sort((a, b) => a - b);
const drawnMatch = JSON.stringify(onchainDrawn) === JSON.stringify(drawn) && rs[126] === 3;
results.push({ label: "on-chain drawn numbers == off-chain draw_numbers(seed, round_id); status Drawn", expected: drawn, pass: drawnMatch, onchain: onchainDrawn, status: rs[126] });
console.log(`[${drawnMatch ? "PASS" : "FAIL"}] drawn ${onchainDrawn} status=${rs[126]}`);

const t = (i, numbers = tickets[i].numbers) => ({ numbers, index: i, proof: proofOf(leaves, i) });
// The pre-fix gap: nullifier-only claim on a Drawn round (any nullifier won).
await send("ATTACK nullifier-only claim on Drawn round (old gap) -> InvalidTicketProof (0x600B)", [claimIx(attacker, randomBytes(32), null, R)], [attacker], { custom: 0x600B }, attacker);
await send("ATTACK anchored LOSING ticket (valid proof) -> TicketNotWinning (0x600A)", [claimIx(loser, tickets[0].nul, t(0), R)], [loser], { custom: 0x600A }, loser);
await send("ATTACK own ticket relabelled with the drawn numbers -> InvalidTicketProof (0x600B)", [claimIx(attacker, tickets[1].nul, t(1, drawn), R)], [attacker], { custom: 0x600B }, attacker);
await send("ATTACK front-run: winner's ticket + proof signed by attacker -> InvalidTicketProof (0x600B)", [claimIx(attacker, tickets[2].nul, t(2), R)], [attacker], { custom: 0x600B }, attacker);
await send("Winner (ticket owner) claims with numbers + proof -> Won", [claimIx(payer, tickets[2].nul, t(2), R)], [], "ok");
await sleep(1500);
const after = (await conn.getAccountInfo(R)).data;
const wonOk = after[126] === 4 && Buffer.from(after.subarray(127, 159)).equals(tickets[2].nul);
results.push({ label: "round status Won, winner_nullifier = winning ticket nullifier", expected: "status 4", pass: wonOk, status: after[126] });
console.log(`[${wonOk ? "PASS" : "FAIL"}] round status=${after[126]} winner bound`);
await send("ATTACK second claim of the same ticket -> AlreadyClaimed (0x6005)", [claimIx(payer, tickets[2].nul, t(2), R)], [], { custom: 0x6005 });

for (const [tag, kp] of [["loser", loser], ["attacker", attacker]]) {
  await sleep(800);
  const bal = await conn.getBalance(kp.publicKey);
  if (bal > 5000) await send(`sweep ${tag} back to payer`, [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: payer.publicKey, lamports: bal - 5000 })], [kp], "ok", kp);
}
finish("probe-lottery-claim-rerun2", { program: P.toBase58(), cfg: cfg.toBase58(), round: rid, roundPda: R.toBase58(), ticketsRoot: root.toString("hex"), ticketCount: tickets.length, drawn, winnerIndex: 2, winnerNullifier: tickets[2].nul.toString("hex") });
