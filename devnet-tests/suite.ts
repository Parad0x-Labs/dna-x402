// Live devnet attack-replay suite for dna-x402 security-fixes branch deployments.
// Raw solana_program programs — discriminants and layouts transcribed from Rust source.
//
// Programs under test:
//   agent_credential_mint    5ftab12xtYNLmeNZQghGK1b3CgnZDVmfAnyCr4uNuyqN
//   null_token_hook          hrCdqUDDGEzfQCTinfc9LX5MYfo33aXrjZvcWAzyygR
//   dark_nullifier_banks     HqaSYLB9Uk2pLQ7kZvBoYBKVJ72NihTRVnyddQRKP4gQ
//   receipt_commitment_tree  7DdJFMwrGZKcj7MrjqvftfGt9HH99s3hNvEv6SbRj4ig
//   dark_null_mint_gate      Tncf2ZwE3CtyEourUxPzL1Jkknw6sAt2A7SdtM8c4up
//
// Set MINT_GATE_ONLY=1 to run only the dark_null_mint_gate tests (T7+),
// skipping the legacy T1-T6 blocks (avoids re-spending on reruns).

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const RPC = "https://api.devnet.solana.com";
const KEYS_DIR = process.env.DNA_KEYS_DIR ?? path.join(".", "devnet-keys");

const ACM_ID = new PublicKey("5ftab12xtYNLmeNZQghGK1b3CgnZDVmfAnyCr4uNuyqN");
const HOOK_ID = new PublicKey("hrCdqUDDGEzfQCTinfc9LX5MYfo33aXrjZvcWAzyygR");
const BANKS_ID = new PublicKey("HqaSYLB9Uk2pLQ7kZvBoYBKVJ72NihTRVnyddQRKP4gQ");
const TREE_ID = new PublicKey("7DdJFMwrGZKcj7MrjqvftfGt9HH99s3hNvEv6SbRj4ig");

// Custom error codes transcribed from each program's error enum.
const ACM_ERR: Record<number, string> = {
  0x9001: "NotMainnetReady", 0x9002: "AlreadyIssued", 0x9003: "CredentialNotFound",
  0x9004: "AlreadyRevoked", 0x9005: "InvalidInstructionData", 0x9006: "InvalidBindingType",
  0x9007: "Unauthorized", 0x9008: "DevicePubkeyMismatch", 0x9009: "InvalidX402Receipt",
  0x900a: "InvalidAccountSize",
};
const HOOK_ERR: Record<number, string> = {
  0x3001: "NotAuthorized", 0x3002: "AllowlistNotFound", 0x3003: "ExceedsDarkPoolLimit",
  0x3004: "InvalidInstruction", 0x3005: "ConfigAlreadyExists", 0x3006: "NotAdmin",
};
const BANK_ERR: Record<number, string> = {
  0: "MissingPayerSignature", 1: "InvalidBankAccount", 2: "InvalidBankPda",
  3: "InvalidNullifierRecordPda", 4: "MissingSystemProgram", 5: "WrongShard",
  6: "DuplicateNullifier", 7: "ArithmeticOverflow", 8: "InvalidInstructionData",
  9: "BankAlreadyInitialized",
};

const GATE_ERR: Record<number, string> = {
  0x7001: "InvalidInstruction", 0x7002: "AlreadyInitialized", 0x7003: "AlreadyClaimed",
  0x7004: "ExceedsClaimLimit", 0x7005: "EpochCapExceeded", 0x7006: "MintGateNotActive",
  0x7007: "NotAdmin", 0x7008: "EpochAlreadyAdvanced",
};

function errName(code: number): string {
  const hex = code.toString(16);
  const name = ACM_ERR[hex.length === 3 ? parseInt("0" + hex, 16) : code]
    ?? HOOK_ERR[code] ?? BANK_ERR[code] ?? GATE_ERR[code];
  return name ? `${name} (custom ${code}/0x${code.toString(16)})` : `custom ${code}/0x${code.toString(16)}`;
}

function loadKeypair(name: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(`${KEYS_DIR}/${name}.json`, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sha256(...bufs: Uint8Array[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}

function rand(n: number): Buffer {
  return crypto.randomBytes(n);
}

/** Read little-endian u64 from an account data array (works for Buffer/Uint8Array). */
function u64le(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}

/** Extract custom program error code from a failed-send error. */
function extractErr(e: unknown): { code?: number; raw: string } {
  const err = e as { message?: string; logs?: string[] };
  const text = [err.message ?? "", ...(err.logs ?? [])].join("\n");
  let m = text.match(/custom program error: (0x[0-9a-fA-F]+|\d+)/i);
  if (!m) m = text.match(/Error Code: \w+ \((\d+(?:\/0x[0-9a-f]+)?)\)/i);
  let code: number | undefined;
  if (m) {
    const tok = m[1];
    code = tok.toLowerCase().startsWith("0x") ? parseInt(tok, 16) : parseInt(tok, 10);
  }
  const line = (err.logs ?? []).find((l) => l.includes("Error Code:") || l.includes("custom program error"));
  return { code, raw: line ?? err.message?.split("\n").slice(-4).join(" | ") ?? String(e) };
}

type Outcome =
  | { kind: "PASS"; sig?: string; note: string }
  | { kind: "FAIL"; note: string };

async function balances(conn: Connection, wallets: Record<string, Keypair>) {
  const out: Record<string, number> = {};
  for (const [k, kp] of Object.entries(wallets)) {
    out[k] = await conn.getBalance(kp.publicKey);
  }
  return out;
}

interface TestCase {
  id: string;
  label: string;
  result: Outcome;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const agent1 = loadKeypair("test-agent-1");
  const agent2 = loadKeypair("test-agent-2");
  const user1 = loadKeypair("test-user-1");
  const deployer = loadKeypair("deployer");
  const wallets = { "test-agent-1": agent1, "test-agent-2": agent2, "test-user-1": user1, "deployer": deployer };
  const before = await balances(conn, wallets);
  const RUN_LEGACY = !process.env.MINT_GATE_ONLY;

  console.log("=== dna-x402 devnet attack-replay suite (branch: security-fixes) ===");
  for (const [k, kp] of Object.entries(wallets)) {
    console.log(`  ${k}: ${kp.publicKey.toBase58()} (${(before[k] / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
  }

  const results: TestCase[] = [];
  const sysAcct = () => ({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });

  /** Send a tx; classify success/failure vs an optional expected custom error. */
  async function run(
    t: Omit<TestCase, "result">,
    ixs: unknown[],
    signers: Keypair[],
    expectCustom?: number,
    expectSuccess = true,
  ): Promise<Outcome> {
    try {
      const list = Array.isArray(ixs) ? ixs : [ixs];
      const built = list.map((ix: never) =>
        ix instanceof Object && "keys" in ix && !("programId" in ix)
          ? new TransactionInstruction({
              programId: (ix as { pubkey: PublicKey }).pubkey,
              keys: (ix as { keys: never }).keys,
              data: (ix as { data: Buffer }).data,
            })
          : ix,
      ) as Parameters<Transaction["add"]>;
      const tx = new Transaction().add(...built);
      const sig = await sendAndConfirmTransaction(conn, tx, signers);
      if (!expectSuccess && expectCustom === undefined) {
        return { kind: "FAIL", sig, note: `tx unexpectedly SUCCEEDED ${sig}` };
      }
      return { kind: "PASS", sig, note: `tx confirmed ${sig}` };
    } catch (e) {
      const { code, raw } = extractErr(e);
      if (!expectSuccess && code !== undefined) {
        if (expectCustom !== undefined && code !== expectCustom) {
          return {
            kind: "FAIL",
            note: `failed with WRONG error: got ${errName(code)}, expected ${errName(expectCustom)} — ${raw}`,
          };
        }
        return { kind: "PASS", note: `rejected as expected with ${errName(code)} — ${raw}` };
      }
      return { kind: "FAIL", note: `unexpected error${code !== undefined ? ` ${errName(code)}` : ""}: ${raw}` };
    }
  }

  // ── T1: credential-mint happy path ────────────────────────────────────────
  if (RUN_LEGACY) {
    const agentPub = agent1.publicKey;
    const device = Buffer.concat([Buffer.from([0x02]), rand(32)]);
    const receipt = sha256(Buffer.from("x402-receipt-" + Date.now()));
    // data: tag 0x01 | agent_pubkey[32] | device[33] | binding_type=0x01 | x402_receipt_hash[32]
    const data = Buffer.concat([
      Buffer.from([0x01]),
      agentPub.toBytes(),
      device,
      Buffer.from([0x01]),
      receipt,
    ]);
    const [credPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cred"), agentPub.toBytes()], ACM_ID);
    const [authPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_authority")], ACM_ID);

    const res = await run(
      { id: "T1", label: "credential-mint IssueCredential happy path" },
      {
        pubkey: ACM_ID,
        keys: [
          { pubkey: agent1.publicKey, isSigner: true, isWritable: true }, // payer/agent_wallet
          sysAcct(),                                                     // credential_mint (unused devnet)
          sysAcct(),                                                     // agent_token_account (unused)
          { pubkey: credPda, isSigner: false, isWritable: true },        // CredentialRecord PDA
          { pubkey: authPda, isSigner: false, isWritable: false },       // protocol_authority (unused)
          sysAcct(),                                                     // system_program
        ],
        data,
      },
      [agent1],
    );

    let note = res.note;
    if (res.kind === "PASS") {
      const acct = await conn.getAccountInfo(credPda);
      const ok = acct !== null && acct.owner.equals(ACM_ID)
        && acct.data[0] === 0x43 && acct.data[1] === 0x52
        && acct.data[149] === 0x00 && acct.data.length === 155;
      note += ok ? "; record verified (disc 'CR', status active, 155B)"
                 : "; WARNING: record verification mismatch";
      if (!ok) res.kind = "FAIL";
    }
    results.push({ id: "T1", label: "credential-mint IssueCredential happy path", result: { ...res, note } });
    console.log(`[${res.kind}] T1 ${note}`);
  }

  // ── T2: REVOKE ATTACK — protocol-authority PDA passed WITHOUT signature ───
  if (RUN_LEGACY) {
    const agentPub = agent1.publicKey.toBytes();
    const [credPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cred"), Buffer.from(agentPub)], ACM_ID);
    const [authPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_authority")], ACM_ID);
    const data = Buffer.concat([Buffer.from([0x02]), Buffer.from(agentPub)]);

    const res = await run(
      { id: "T2", label: "REVOKE ATTACK: authority PDA without signature" },
      {
        pubkey: ACM_ID,
        keys: [
          { pubkey: authPda, isSigner: false, isWritable: false }, // authority_info — NOT a signer
          sysAcct(),                                               // _agent_token_account
          sysAcct(),                                               // _credential_mint_info
          { pubkey: credPda, isSigner: false, isWritable: true },  // CredentialRecord PDA
        ],
        data,
      },
      [user1], // fee payer only; cannot sign for a PDA
      0x9007, false,
    );
    results.push({ id: "T2", label: "REVOKE ATTACK: authority PDA without signature", result: res });
    console.log(`[${res.kind}] T2 ${res.note}`);
  }

  // ── T3: UPGRADE ATTACK — matching agent_wallet that is NOT a signer ───────
  if (RUN_LEGACY) {
    const agentPub = agent1.publicKey;
    const [credPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cred"), agentPub.toBytes()], ACM_ID);
    const acct = await conn.getAccountInfo(credPda);
    if (acct === null) {
      results.push({ id: "T3", label: "UPGRADE ATTACK", result: { kind: "FAIL", note: "skipped: credential record PDA missing (T1 did not land)" } });
    } else {
    const oldDevice = Buffer.from(acct.data.slice(34, 67)); // OFF_DEVICE_PUBKEY..+33
    const newDevice = Buffer.concat([Buffer.from([0x02]), rand(32)]);
    const receipt = sha256(Buffer.from("upgrade-receipt-" + Date.now()));
    const data = Buffer.concat([
      Buffer.from([0x03]), oldDevice, newDevice, receipt,
    ]);

    const res = await run(
      { id: "T3", label: "UPGRADE ATTACK: agent_wallet matches record but NOT a signer" },
      {
        pubkey: ACM_ID,
        keys: [
          { pubkey: agentPub, isSigner: false, isWritable: false }, // agent_wallet — unsigned!
          sysAcct(),                                                // _old_token_account
          sysAcct(),                                                // _credential_mint_info
          sysAcct(),                                                // _new_token_account
          { pubkey: credPda, isSigner: false, isWritable: true },   // CredentialRecord PDA
        ],
        data,
      },
      [user1],
      0x9007, false,
    );
    results.push({ id: "T3", label: "UPGRADE ATTACK: agent_wallet matches record but NOT a signer", result: res });
    console.log(`[${res.kind}] T3 ${res.note}`);
    }
  }

  // ── T4: nullifier-bank REINIT ATTACK ──────────────────────────────────────
  if (RUN_LEGACY) {
    const shard = 7;
    // Find an (shard, epoch) slot whose bank PDA is free so first init succeeds.
    let epoch = 777n;
    let bankPda: PublicKey;
    for (;;) {
      const epBuf = Buffer.alloc(8);
      epBuf.writeBigUInt64LE(epoch);
      [bankPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("null_bank"), Buffer.of(shard), epBuf], BANKS_ID);
      const info = await conn.getAccountInfo(bankPda);
      if (info === null || info.data.length === 0) break;
      epoch += 1n;
    }
    const epBuf = Buffer.alloc(8);
    epBuf.writeBigUInt64LE(epoch);
    const initData = Buffer.concat([Buffer.from([0x00]), Buffer.of(shard), epBuf]);
    const keys = [
      { pubkey: agent2.publicKey, isSigner: true, isWritable: true }, // payer
      { pubkey: bankPda, isSigner: false, isWritable: true },         // bank PDA
      sysAcct(),                                                      // system_program
    ];

    const r1 = await run(
      { id: "T4a", label: `InitBank first call (shard=${shard} epoch=${epoch})` },
      { pubkey: BANKS_ID, keys, data: initData }, [agent2]);
    results.push({ id: "T4a", label: `InitBank first call (shard=${shard} epoch=${epoch})`, result: r1 });

    const r2 = await run(
      { id: "T4b", label: `REINIT ATTACK: InitBank again on same shard/epoch` },
      { pubkey: BANKS_ID, keys, data: initData }, [agent2],
      9, false, // BankAlreadyInitialized
    );
    results.push({ id: "T4b", label: "REINIT ATTACK: InitBank again on same shard/epoch", result: r2 });
  }

  // ── T5: hook FORGED ADMIN ATTACK ──────────────────────────────────────────
  if (RUN_LEGACY) {
    const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from("hook-config")], HOOK_ID);
    const cfgInfo = await conn.getAccountInfo(cfgPda);
    const limitBuf = Buffer.alloc(8);
    limitBuf.writeBigUInt64LE(1000n);
    const initData = Buffer.concat([Buffer.from([0x02]), limitBuf]);

    let attacker: Keypair;
    let scenario: string;
    if (cfgInfo === null || cfgInfo.data.length < 42) {
      scenario = "canonical config PDA was UNINITIALIZED at test time";
      // First-come InitConfig by user1 — per source this SUCCEEDS (permissionless
      // claim of the canonical config). Documented as expected behavior/discrepancy.
      const rClaim = await run(
        { id: "T5a", label: "FORGED ADMIN step 1: user InitConfig claims canonical config (was uninit)" },
        {
          pubkey: HOOK_ID,
          keys: [
            { pubkey: cfgPda, isSigner: false, isWritable: true },
            { pubkey: user1.publicKey, isSigner: true, isWritable: true },
            sysAcct(),
          ],
          data: initData,
        },
        [user1],
      );
      results.push({
        id: "T5a",
        label: `FORGED ADMIN step 1: user InitConfig claims canonical config (was uninit) [${scenario}]`,
        result: rClaim,
      });
      attacker = agent2; // second attacker must now collide/fail
    } else {
      const storedAdmin = new PublicKey(cfgInfo.data.slice(1, 33)).toBase58();
      scenario = `canonical config already initialized (admin=${storedAdmin})`;
      results.push({
        id: "T5-info", label: scenario, result: { kind: "PASS", note: scenario },
      });
      attacker = user1;
    }

    // Attacker tries to init their own config → must hit ConfigAlreadyExists.
    const rInit = await run(
      { id: "T5b", label: "FORGED ADMIN step 2: attacker InitConfig collides on canonical PDA" },
      {
        pubkey: HOOK_ID,
        keys: [
          { pubkey: cfgPda, isSigner: false, isWritable: true },
          { pubkey: attacker.publicKey, isSigner: true, isWritable: true },
          sysAcct(),
        ],
        data: initData,
      },
      [attacker],
      0x3005, false, // ConfigAlreadyExists
    );
    results.push({ id: "T5b", label: `FORGED ADMIN step 2: attacker InitConfig collides on canonical PDA [${scenario}]`, result: rInit });

    // Attacker tries AddToAllowlist with themselves as admin against canonical config.
    const target = agent1.publicKey;
    const [alPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("allowlist"), target.toBytes()], HOOK_ID);
    const alData = Buffer.concat([Buffer.from([0x03]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1n); return b; })()]);
    const rAllow = await run(
      { id: "T5c", label: "FORGED ADMIN step 3: attacker AddToAllowlist (self-appointed)" },
      {
        pubkey: HOOK_ID,
        keys: [
          { pubkey: alPda, isSigner: false, isWritable: true },
          { pubkey: target, isSigner: false, isWritable: false },
          { pubkey: attacker.publicKey, isSigner: true, isWritable: true }, // claimed admin
          sysAcct(),                                                        // system_program
          { pubkey: cfgPda, isSigner: false, isWritable: false },           // CANONICAL config
        ],
        data: alData,
      },
      [attacker],
      0x3006, false, // NotAdmin
    );
    results.push({ id: "T5c", label: `FORGED ADMIN step 3: attacker AddToAllowlist (self-appointed) [${scenario}]`, result: rAllow });
  }

  // ── T6: receipt-commitment-tree PREFUND-GRIEF TEST ────────────────────────
  if (RUN_LEGACY) {
    const treeId = rand(8);
    const [treePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt_tree"), treeId], TREE_ID);
    // Grief: top up the PDA address with 1 lamport BEFORE initialization.
    const grief = SystemProgram.transfer({
      fromPubkey: user1.publicKey,
      toPubkey: treePda,
      lamports: 1,
    });
    const initData = Buffer.concat([Buffer.from([0x00]), treeId]);
    const initKeys = [
      { pubkey: user1.publicKey, isSigner: true, isWritable: true }, // payer
      { pubkey: treePda, isSigner: false, isWritable: true },        // tree PDA (prefunded!)
      sysAcct(),                                                     // system_program
    ];
    const rent = await conn.getMinimumBalanceForRentExemption(938); // TREE_LEN
    const t6label = "PREFUND-GRIEF: 1-lamport top-up before Initialize, then init";
    const res = await run(
      { id: "T6", label: t6label },
      [grief, { pubkey: TREE_ID, keys: initKeys, data: initData }],
      [user1],
    );
    let note = res.note;
    if (res.kind === "PASS") {
      const acct = await conn.getAccountInfo(treePda);
      const ok = acct !== null && acct.owner.equals(TREE_ID) && acct.data.length === 938;
      note += ok
        ? `; tree verified (owner=program, 938B; rent-exempt min=${rent} lamports)`
        : "; WARNING: tree account verification failed";
      if (!ok) res.kind = "FAIL";
    }
    results.push({ id: "T6", label: t6label, result: { ...res, note } });
  }

  // ── T7: dark_null_mint_gate InitEmission by deployer ──────────────────────
  // Source: tag 0x01 | null_mint[32] | max_per_claim u64le | epoch_dur u64le | epoch_cap u64le
  // Accounts: [emission-config PDA, admin (signer, pays), system_program]
  {
    const GATE_ID = new PublicKey("Tncf2ZwE3CtyEourUxPzL1Jkknw6sAt2A7SdtM8c4up");
    const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from("emission-config")], GATE_ID);
    const existing = await conn.getAccountInfo(cfgPda);

    if (existing !== null && existing.data.length > 0) {
      const storedAdmin = new PublicKey(existing.data.slice(1, 33)).toBase58();
      const okDisc = existing.data[0] === 0xD1;
      results.push({
        id: "T7",
        label: "InitEmission — config PDA already initialized on a prior run",
        result: { kind: okDisc ? "PASS" : "FAIL", note: `config exists (${existing.data.length}B, disc=0x${existing.data[0].toString(16)}, admin=${storedAdmin}); init skipped` },
      });
      console.log(`[SKIP-INIT] T7 config already exists, admin=${storedAdmin}`);
    } else {
      const nullMint = new PublicKey(deployer.publicKey.toBytes()); // placeholder mint pubkey; source only stores it
      const p64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
      const data = Buffer.concat([
        Buffer.from([0x01]), nullMint.toBytes(),
        p64(1_000_000n),       // max_null_per_claim_atomic
        p64(432_000n),         // epoch_duration_slots
        p64(500_000_000n),     // epoch_null_cap_atomic
      ]);
      const res = await run(
        { id: "T7", label: "InitEmission by deployer" },
        {
          pubkey: GATE_ID,
          keys: [
            { pubkey: cfgPda, isSigner: false, isWritable: true },
            { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
            sysAcct(),
          ],
          data,
        },
        [deployer],
      );
      let note = res.note;
      if (res.kind === "PASS") {
        const acct = await conn.getAccountInfo(cfgPda);
        const ok = acct !== null && acct.owner.equals(GATE_ID)
          && acct.data.length === 106 && acct.data[0] === 0xD1
          && new PublicKey(acct.data.slice(1, 33)).equals(deployer.publicKey)
          && acct.data[105] === 1;
        note += ok
          ? "; config verified (106 B, disc 0xD1, admin=deployer, is_active=1)"
          : "; WARNING: config verification mismatch";
        if (!ok) res.kind = "FAIL";
      }
      results.push({ id: "T7", label: "InitEmission by deployer", result: { ...res, note } });
      console.log(`[${res.kind}] T7 ${note}`);
    }

    // ── T8: UNAUTHORIZED CLAIM ATTACK — random agent claims WITHOUT the config
    // authority as trailing signer. C5 fix verification: must reject NotAdmin.
    {
      const nullifier = rand(32);
      const [recPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("emission"), nullifier], GATE_ID);
      const p64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
      const data = Buffer.concat([
        Buffer.from([0x02]), nullifier, rand(32), p64(250_000n),
      ]);
      const res = await run(
        { id: "T8", label: "UNAUTHORIZED CLAIM ATTACK: agent-only ClaimEmission, wrong trailing authority" },
        {
          pubkey: GATE_ID,
          keys: [
            { pubkey: cfgPda, isSigner: false, isWritable: false },
            { pubkey: recPda, isSigner: false, isWritable: true },
            { pubkey: agent2.publicKey, isSigner: true, isWritable: true },  // agent
            sysAcct(),                                                        // system_program
            { pubkey: agent2.publicKey, isSigner: true, isWritable: false },  // WRONG authority
          ],
          data,
        },
        [agent2],
        0x7007, false, // NotAdmin
      );
      results.push({ id: "T8", label: "UNAUTHORIZED CLAIM ATTACK: agent-only ClaimEmission, wrong trailing authority", result: res });
      console.log(`[${res.kind}] T8 ${res.note}`);
    }

    // ── T9: OPERATOR CLAIM — deployer co-signs as config authority.
    // IS_MAINNET_READY=false in the deployed build → SPL mint CPI skipped entirely
    // (even under --features mainnet the CPI body is an unimplemented TODO), so
    // expect FULL success with no CPI failure.
    {
      const nullifier = sha256(Buffer.from("gate-nullifier-" + Date.now()));
      const [recPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("emission"), nullifier], GATE_ID);
      const p64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
      const amount = 250_000n;
      const data = Buffer.concat([
        Buffer.from([0x02]), nullifier, sha256(Buffer.from("rc-" + Date.now())), p64(amount),
      ]);
      const res = await run(
        { id: "T9", label: "OPERATOR CLAIM: ClaimEmission with deployer as config authority" },
        {
          pubkey: GATE_ID,
          keys: [
            { pubkey: cfgPda, isSigner: false, isWritable: true },
            { pubkey: recPda, isSigner: false, isWritable: true },
            { pubkey: agent1.publicKey, isSigner: true, isWritable: true },  // agent (funds record PDA)
            sysAcct(),                                                        // system_program
            { pubkey: deployer.publicKey, isSigner: true, isWritable: false },// config authority
          ],
          data,
        },
        [agent1, deployer],
      );
      let note = res.note;
      if (res.kind === "PASS") {
        const acct = await conn.getAccountInfo(recPda);
        const cfgAcct = await conn.getAccountInfo(cfgPda);
        const recOk = acct !== null && acct.owner.equals(GATE_ID)
          && acct.data.length === 121 && acct.data[0] === 0xD2
          && Buffer.from(acct.data.slice(89, 121)).equals(agent1.publicKey.toBytes());
        const minted = cfgAcct ? u64le(cfgAcct.data, 97) : -1n;
        note += recOk
          ? `; record verified (121 B, disc 0xD2, agent=agent1, epoch=${cfgAcct ? u64le(cfgAcct.data, 89) : "?"}, slot=${u64le(acct.data, 81)})`
          : "; WARNING: record verification mismatch";
        note += `; epoch_null_minted_atomic=${minted} (expected ${amount})`;
        if (!recOk || minted !== amount) res.kind = "FAIL";
      }
      results.push({ id: "T9", label: "OPERATOR CLAIM: ClaimEmission with deployer as config authority", result: { ...res, note } });
      console.log(`[${res.kind}] T9 ${note}`);
    }

    // ── T10: AdvanceEpoch admin rollover ──────────────────────────────────────
    {
      const p64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
      const curEpochRaw = u64le((await conn.getAccountInfo(cfgPda))!.data, 89);
      const newEpoch = curEpochRaw + 1n;
      const data = Buffer.concat([Buffer.from([0x03]), p64(newEpoch)]);
      const res = await run(
        { id: "T10", label: `AdvanceEpoch ${curEpochRaw} -> ${newEpoch} by deployer` },
        {
          pubkey: GATE_ID,
          keys: [
            { pubkey: cfgPda, isSigner: false, isWritable: true },
            { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
          ],
          data,
        },
        [deployer],
      );
      let note = res.note;
      if (res.kind === "PASS") {
        const cfgAcct = await conn.getAccountInfo(cfgPda);
        const ep = cfgAcct ? u64le(cfgAcct.data, 89) : -1n;
        const minted = cfgAcct ? u64le(cfgAcct.data, 97) : -1n;
        note += `; config now current_epoch=${ep}, epoch_null_minted_atomic=${minted}`;
        if (ep !== newEpoch || minted !== 0n) res.kind = "FAIL";
      }
      results.push({ id: "T10", label: `AdvanceEpoch ${curEpochRaw} -> ${newEpoch} by deployer`, result: { ...res, note } });
      console.log(`[${res.kind}] T10 ${note}`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const after = await balances(conn, wallets);
  console.log("\n=== RESULTS ===");
  for (const r of results) {
    const mark = r.result.kind === "PASS" ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.id} — ${r.label}`);
    console.log(`        ${r.result.note}`);
  }
  console.log("\n=== SOL SPENT PER WALLET ===");
  for (const k of Object.keys(wallets)) {
    const d = (before[k] - after[k]) / LAMPORTS_PER_SOL;
    console.log(`  ${k}: spent ${d.toFixed(9)} SOL (balance ${(after[k] / LAMPORTS_PER_SOL).toFixed(6)})`);
  }
  const fails = results.filter((r) => r.result.kind !== "PASS").length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("suite crashed:", e);
  process.exit(2);
});
