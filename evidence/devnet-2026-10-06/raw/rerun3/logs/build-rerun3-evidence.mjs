// Build *-rerun3.json evidence: every signature in the rerun-3 probe and the upgrade is re-read
// from devnet (slot, err, fee, balance delta). Writes /w/out/*.json.
import { Connection } from "@solana/web3.js";
import fs from "node:fs";
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAYER = "GTs3YgDY4Aqi67wW4zr5xZdJCwBVHiwTrRdgWpFPjXD3";
const DEPLOYER = "9Jkphdpu3UQKgZToacyfDkwM3ZbzPjZYuK3sDyR8pU2q";
const PROGRAM = "Ecs5Ch2AWThxpkgqxMHcgNeAz4nTqpmoFWRDD6bufLXd";
const REPO = "dna-x402@7439dde (fix(dark_null_lottery): a FallbackDraw winner must be the selected anchored ticket)";
const up = JSON.parse(fs.readFileSync("/w/in/upgrade.json", "utf8"));
fs.mkdirSync("/w/out", { recursive: true });

async function tx(sig, who) {
  for (let i = 0; i < 12; i++) {
    try {
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (t?.meta) {
        const keys = t.transaction.message.staticAccountKeys ?? t.transaction.message.accountKeys;
        const ix = keys.findIndex((k) => k.toBase58() === who);
        const delta = ix >= 0 ? t.meta.postBalances[ix] - t.meta.preBalances[ix] : 0;
        return { sig, slot: t.slot, err: t.meta.err, fee: t.meta.fee, delta, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet` };
      }
    } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return { sig, notFound: true };
}
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

// ── upgrade ──
const upTx = await tx(up.sig, DEPLOYER);
fs.writeFileSync("/w/out/devnet-upgrades-rerun3.json", JSON.stringify({
  date: "2026-10-06", cluster: "devnet", repo: REPO, deployer: DEPLOYER,
  build: "cargo build-sbf (platform-tools v1.54, cargo-build-sbf 4.1.0), offline in container dnax-sbf-build from the tree committed as 7439dde; program tests run natively and against this .so (SBF_OUT_DIR)",
  upgrades: [{
    program: "dark_null_lottery", id: PROGRAM, commit: "7439dde", bytes: up.bytes, sha256: up.sha256, extend: 0,
    programDataLength: up.programDataLength, sig: up.sig, tx: upTx, onchainPrefixSha256Match: up.match, nonzeroTail: up.nonzeroTail,
    lastDeployedSlot: up.slot,
  }],
  deployerLamports: { before: up.before, after: up.after, spent: up.before - up.after },
  buffersOpenAfter: 0,
  notes: [
    "solana program deploy <so> --program-id <keypair> --upgrade-authority deployer (Agave CLI 4.2.1). The .so (95432 bytes) fits the existing 99512-byte program data, so no extend; the buffer rent came back on upgrade.",
    "On-chain program bytes re-dumped; the first 95432 bytes hash to the built .so and the remainder is zero.",
  ],
}, null, 2) + "\n");

// ── lottery probe ──
const probe = JSON.parse(fs.readFileSync("/w/logs/probe-lottery-claim-rerun3.json", "utf8"));
const signatures = [];
for (const r of probe.results.filter((r) => r.sig)) { signatures.push(await tx(r.sig, PAYER)); await sleep(350); }
const bySig = Object.fromEntries(signatures.map((s) => [s.sig, s]));
const tests = probe.results.map((r) => {
  if (!r.sig) return { t: r.label, r: `${r.pass ? "PASS" : "FAIL"} (account state read back)`, ...(r.statuses ? { statuses: r.statuses } : {}), ...(r.status !== undefined ? { status: r.status } : {}) };
  const l = bySig[r.sig];
  const want = r.expected === "success" ? null : r.expected.custom;
  const ledgerOk = l && !l.notFound && (want === null ? l.err === null : JSON.stringify(l.err ?? "").includes(`"Custom":${want}`));
  return { t: r.label, expected: r.expected, r: `${ledgerOk ? "PASS" : "FAIL"} ${l?.err === null ? "ok" : JSON.stringify(l?.err)}`, sig: r.sig, slot: l?.slot };
});
const pass = tests.filter((t) => t.r.startsWith("PASS")).length;
const payerNet = signatures.reduce((a, s) => a + (s.delta ?? 0), 0);
fs.writeFileSync("/w/out/dna-probe-lottery-claim-rerun3.json", JSON.stringify({
  suite: "dna-probe-lottery-claim", repo: REPO, cluster: "devnet", rpc: "https://api.devnet.solana.com",
  command: `PROGRAM=${PROGRAM} node lottery-claim-rerun3.mjs`,
  programId: { dark_null_lottery: PROGRAM },
  result: pass === tests.length ? "PASS" : "FAIL", pass, fail: tests.length - pass, timestamp: now,
  drawnRound: probe.drawnRound, fallback: probe.fallback,
  payerNetLamports: payerNet,
  signatures, tests,
  notes: [
    "dark_null_lottery upgraded in place 2026-10-06 (rerun 3, 7439dde): FallbackDraw takes three consecutive Drawn rounds, requires the third round's committed draw seed (SHA-256 vs its CommitRound commitment) and its anchored tickets_root / ticket_count as the pool, and records no winner; ClaimJackpot on the FallbackDrawn round needs the selected ticket's ticket.rs leaf + proof built from the claimant key.",
    "Part A repeats the rerun-2 drawn-numbers cases on a fresh round. Part B: FallbackDraw by a non-admin (0x6008), with an uncommitted seed or another round's seed (0x6004), a pool root or size that is not the anchored tree (0x600C), rounds out of order (0x600E) all fail and leave the rounds Drawn; the valid FallbackDraw sets NoWinner/NoWinner/FallbackDrawn with no winner recorded.",
    "Claims on the FallbackDrawn round: the old synthetic nullifier SHA-256(seed||\"fallback\"||idx) and the selected ticket's nullifier without a ticket (0x600B), an unselected ticket carrying the drawn numbers signed by its owner (0x600D), the selected ticket + proof under another signer (0x600B) fail; the selected ticket's owner claims (Won, winner_nullifier = that ticket's nullifier); a second claim fails 0x6005; a NoWinner round's ticket fails 0x6007; FallbackDraw again fails 0x6007.",
    "The random draw seed selected index 0 on devnet; the program tests (native and SBF) pin a seed that selects index 3.",
    "The test payer is also the lottery admin, so it signs CommitRound/AnchorTickets/RevealDraw/FallbackDraw and owns the winning tickets. Child wallets (loser, attacker) funded 0.01 SOL each and swept back to the payer.",
    "Outcomes graded from the ledger (getTransaction meta.err) and round account reads.",
  ],
  log: "evidence/raw/rerun3/logs/probe-lottery-claim-rerun3.log",
  probeSource: "evidence/raw/rerun3/logs/lottery-claim-rerun3.mjs",
}, null, 2) + "\n");

fs.writeFileSync("/w/out/summary-rerun3.json", JSON.stringify({
  date: "2026-10-06", cluster: "devnet", repo: REPO,
  upgrade: { program: "dark_null_lottery", id: PROGRAM, sig: up.sig, slot: upTx.slot, sha256: up.sha256, deployerSpentLamports: up.before - up.after },
  suites: [{ suite: "dna-probe-lottery-claim", file: "dna-probe-lottery-claim-rerun3.json", result: pass === tests.length ? "PASS" : "FAIL", pass, fail: tests.length - pass }],
  payerNetLamports: payerNet,
  generatedAt: now,
}, null, 2) + "\n");
console.log(`upgrade slot=${upTx.slot} err=${JSON.stringify(upTx.err)}; lottery ${pass}/${tests.length}; payerNet=${payerNet}`);
