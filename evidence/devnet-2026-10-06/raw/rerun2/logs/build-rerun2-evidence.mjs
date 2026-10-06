// Build *-rerun2.json evidence from the rerun-2 logs: every signature is re-read from devnet
// (slot, err, payer balance delta). Writes /w/out/*.json.
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAYER = "GTs3YgDY4Aqi67wW4zr5xZdJCwBVHiwTrRdgWpFPjXD3";
const DEPLOYER = "9Jkphdpu3UQKgZToacyfDkwM3ZbzPjZYuK3sDyR8pU2q";
const REPO = "dna-x402@a32933d (fixes aabb759 dark_secp256k1_auth, a32933d dark_null_lottery)";
const SIG_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![1-9A-HJ-NP-Za-km-z])/g;
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
const sigsIn = (txt) => [...new Set([...txt.matchAll(SIG_RE)].map((m) => m[0]))];
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
let payerNet = 0;

// ── passport 03 ──
{
  const log = fs.readFileSync("/w/logs/passport-03-rerun2.log", "utf8");
  const ev = JSON.parse(fs.readFileSync("/w/src/evidence/passport/metamask-eth-binding-e2e.json", "utf8"));
  const signatures = []; for (const s of sigsIn(log)) { signatures.push(await tx(s, PAYER)); await sleep(400); }
  payerNet += signatures.reduce((a, s) => a + (s.delta ?? 0), 0);
  const tests = ev.transactions.map((r) => ({ t: r.label, expected: r.expected, r: `${r.pass ? "PASS" : "FAIL"} ${r.err === null ? "ok" : JSON.stringify(r.err)}`, sig: r.sig }));
  tests.push({ t: "squat-record-absent", r: ev.results.rejectSquatReplay.pass ? "PASS record PDA not created by the squat attempt" : "FAIL" });
  tests.push({ t: "record-bound-to-intended-agent", r: ev.results.intendedAgentRegisters.pass ? `PASS agent ${PAYER}` : "FAIL" });
  const pass = tests.filter((t) => t.r.startsWith("PASS")).length;
  fs.writeFileSync("/w/out/dna-passport-03-metamask-rerun2.json", JSON.stringify({
    suite: "dna-passport-03-metamask", repo: REPO, cluster: "devnet", rpc: "https://api.devnet.solana.com",
    command: "node scripts/passport/03-devnet-metamask-e2e.mjs 7dF2fZgPc9nzSwYroNzUtZGsFTzSbiKsVykcYLc7eiWu",
    programId: { dark_secp256k1_auth: "7dF2fZgPc9nzSwYroNzUtZGsFTzSbiKsVykcYLc7eiWu" },
    result: pass === tests.length ? "PASS" : "FAIL", pass, fail: tests.length - pass, timestamp: ev.generatedAt,
    signatures, tests,
    notes: [
      "dark_secp256k1_auth upgraded in place 2026-10-06 (rerun 2): the precompile-verified message must be the canonical EIP-191 binding message naming the program id, the agent signer, the ETH address, domain_hash and auth_hash.",
      "squat-replay: a funded second Solana key submitted the precompile ix + fields of a signature made for the test payer, signing as agent -> 0x500A BindingMessageMismatch (20490); the record PDA stayed absent and the intended agent then registered the same ETH address.",
      "legacy-unbound-message: the pre-fix format (bare 32-byte message) -> 0x500A.",
      "Outcomes graded from the ledger (getTransaction meta.err).",
    ],
    log: "evidence/raw/rerun2/logs/passport-03-rerun2.log",
  }, null, 2) + "\n");
}

// ── bv7x ──
{
  const log = fs.readFileSync("/w/logs/bv7x-eth-passport-rerun2.log", "utf8");
  const signatures = []; for (const s of sigsIn(log)) { signatures.push(await tx(s, PAYER)); await sleep(400); }
  payerNet += signatures.reduce((a, s) => a + (s.delta ?? 0), 0);
  const ok = signatures.length === 1 && signatures[0].err === null;
  const pda = log.match(/PDA:\s+(\S+)/)?.[1];
  const info = pda ? await conn.getAccountInfo(new PublicKey(pda)) : null;
  const bound = info ? new PublicKey(info.data.subarray(21, 53)).toBase58() : null;
  fs.writeFileSync("/w/out/dna-bv7x-eth-passport-rerun2.json", JSON.stringify({
    suite: "dna-bv7x-eth-passport", repo: REPO, cluster: "devnet", rpc: "https://api.devnet.solana.com",
    command: "SECP256K1_AUTH_PROGRAM_ID=7dF2fZgPc9nzSwYroNzUtZGsFTzSbiKsVykcYLc7eiWu SOLANA_RPC_URL=https://api.devnet.solana.com node scripts/integrations/bv7x-eth-passport.mjs --test",
    programId: { dark_secp256k1_auth: "7dF2fZgPc9nzSwYroNzUtZGsFTzSbiKsVykcYLc7eiWu" },
    result: ok && bound === PAYER ? "PASS" : "FAIL", pass: ok && bound === PAYER ? 1 : 0, fail: ok && bound === PAYER ? 0 : 1, timestamp: now,
    signatures, tests: [{ t: "register (binding message via scripts/passport/lib/eth-agent.mjs)", r: ok ? `PASS ${signatures[0].sig.slice(0, 20)}...` : "FAIL", recordPda: pda, recordAgent: bound }],
    notes: ["bv7x-eth-passport now signs the canonical binding message (program id + Solana key) through the shared client lib."],
    log: "evidence/raw/rerun2/logs/bv7x-eth-passport-rerun2.log",
  }, null, 2) + "\n");
}

// ── lottery ──
{
  const probe = JSON.parse(fs.readFileSync("/w/logs/probe-lottery-claim-rerun2.json", "utf8"));
  const signatures = [];
  for (const r of probe.results.filter((r) => r.sig)) { signatures.push(await tx(r.sig, PAYER)); await sleep(400); }
  payerNet += signatures.reduce((a, s) => a + (s.delta ?? 0), 0);
  const pass = probe.results.filter((r) => r.pass).length;
  fs.writeFileSync("/w/out/dna-probe-lottery-claim-rerun2.json", JSON.stringify({
    suite: "dna-probe-lottery-claim", repo: REPO, cluster: "devnet", rpc: "https://api.devnet.solana.com",
    command: "PROGRAM=Ecs5Ch2AWThxpkgqxMHcgNeAz4nTqpmoFWRDD6bufLXd node lottery-claim-rerun2.mjs",
    programId: { dark_null_lottery: "Ecs5Ch2AWThxpkgqxMHcgNeAz4nTqpmoFWRDD6bufLXd" },
    result: pass === probe.results.length ? "PASS" : "FAIL", pass, fail: probe.results.length - pass, timestamp: now,
    round: { id: probe.round, pda: probe.roundPda, ticketsRoot: probe.ticketsRoot, ticketCount: probe.ticketCount, drawn: probe.drawn, winnerIndex: probe.winnerIndex, winnerNullifier: probe.winnerNullifier },
    signatures,
    tests: probe.results.map(({ logs, explorer, ...r }) => r),
    notes: [
      "dark_null_lottery upgraded in place 2026-10-06 (rerun 2): ClaimJackpot on a Drawn round requires the claimant's anchored ticket (numbers, leaf index, Merkle proof under tickets_root) with numbers equal to the drawn numbers.",
      "The pre-fix gap (first nullifier-only claim on a Drawn round wins) now fails with InvalidTicketProof 0x600B (24587); an anchored losing ticket fails with TicketNotWinning 0x600A (24586); a ticket relabelled with the drawn numbers and the winner's ticket replayed by another signer fail with 0x600B; the owner of the winning ticket claims; a second claim fails with AlreadyClaimed 0x6005.",
      "The test operator is also the round admin, so the winning ticket was built from the committed seed before anchoring (fixture).",
      "Probe source: evidence/raw/rerun2/logs/lottery-claim-rerun2.mjs (+ lib.mjs from the first rerun).",
    ],
    log: "evidence/raw/rerun2/logs/probe-lottery-claim-rerun2.log",
  }, null, 2) + "\n");
}

// ── upgrades ──
{
  const ups = [
    { program: "dark_secp256k1_auth", id: "7dF2fZgPc9nzSwYroNzUtZGsFTzSbiKsVykcYLc7eiWu", commit: "aabb759", bytes: 89104, sha256: "3af9a00dd6ab9d7110da4b4c293a89633c702211f09d9af2ba0469b3f13457b3", extend: 10240, programDataLength: 94056, sig: "23ddExeQE77PMdDMfbWzG5KUUjNUSkj8ZcHETk97z7a7VFWH7AbR7vYPi7VD4t2bjar4ghetbtZvVgrwi9phiQP5" },
    { program: "dark_null_lottery", id: "Ecs5Ch2AWThxpkgqxMHcgNeAz4nTqpmoFWRDD6bufLXd", commit: "a32933d", bytes: 94872, sha256: "be7f3cc6456be06fd6b3d917be1c94b14f1e213c2fe6ed000d96676d2ef845a1", extend: 10240, programDataLength: 99512, sig: "2VhbnYX8U4xdVhbqAyqrvgK9xvTbeNMUPVczHQe8JCLioJCk6yVhZBpTQjtBi7Q46ZjiYwNaxCDJQF94BVAoCxPS" },
  ];
  for (const u of ups) { Object.assign(u, { tx: await tx(u.sig, DEPLOYER) }); await sleep(400); }
  fs.writeFileSync("/w/out/devnet-upgrades-rerun2.json", JSON.stringify({
    date: "2026-10-06", cluster: "devnet", repo: REPO, deployer: DEPLOYER,
    build: "cargo build-sbf (platform-tools v1.54, cargo-build-sbf 4.1.0), offline in container dnax-sbf-build from the working tree later committed as aabb759/a32933d; program tests also run against these .so files (SBF_OUT_DIR)",
    upgrades: ups.map((u) => ({ ...u, onchainPrefixSha256Match: true })),
    deployerLamports: { before: 1554207145, after: 1449213745, spent: 104993400 },
    buffersOpenAfter: 0,
    notes: ["solana program extend <id> 10240 then solana program deploy <so> --program-id <keypair> --upgrade-authority deployer (Agave CLI 4.2.1). On-chain program bytes re-dumped; the first <bytes> bytes hash to the built .so and the remainder is zero."],
  }, null, 2) + "\n");
}

fs.writeFileSync("/w/out/summary-rerun2.json", JSON.stringify({ payerNetLamportsFromTxMeta: payerNet, payer: PAYER }, null, 2) + "\n");
console.log("payer net from tx meta:", payerNet);
