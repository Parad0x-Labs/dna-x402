#!/usr/bin/env tsx
/**
 * devnet-shard-message.ts — Dark Null Devnet Ritual Evidence Generator
 *
 * Encodes MESSAGE (default "DARKNULL") into Solana devnet by brute-forcing
 * 32-byte nullifiers whose shard index (bank_index) equals the ASCII code of
 * each character, then submitting InsertNullifier transactions on-chain.
 *
 * ── Setup ──────────────────────────────────────────────────────────────────────
 *   npm install                    # install @solana/web3.js at workspace root
 *   solana-keygen new              # if no keypair yet
 *   solana airdrop 2 <pubkey> --url devnet
 *   cargo build-sbf                # compile all programs
 *   solana program deploy target/deploy/dark_nullifier_banks.so --url devnet
 *   solana program deploy target/deploy/dark_compressed_receipts.so --url devnet
 *   solana program deploy target/deploy/dark_chaff.so --url devnet
 *
 * ── Run ────────────────────────────────────────────────────────────────────────
 *   export DARK_NULLIFIER_BANKS_ID=<program_id>
 *   export DARK_COMPRESSED_RECEIPTS_ID=<program_id>
 *   export DARK_CHAFF_ID=<program_id>
 *   npx tsx scripts/devnet-shard-message.ts
 *
 *   # Skip actual txs (pure computation + evidence doc only):
 *   DRY_RUN=true npx tsx scripts/devnet-shard-message.ts
 *
 * ── Environment ────────────────────────────────────────────────────────────────
 *   SOLANA_RPC_URL              (default: https://api.devnet.solana.com)
 *   SOLANA_KEYPAIR_PATH         (default: ~/.config/solana/id.json)
 *   DARK_NULLIFIER_BANKS_ID     deployed program ID  [REQUIRED for live mode]
 *   DARK_COMPRESSED_RECEIPTS_ID deployed program ID  [REQUIRED for live mode]
 *   DARK_CHAFF_ID               deployed program ID  [REQUIRED for live mode]
 *   MESSAGE                     string to encode      (default: DARKNULL)
 *   EPOCH                       u64 epoch             (default: 0)
 *   DRY_RUN                     true = skip all txs   (default: false)
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ── Resolve @solana/web3.js ───────────────────────────────────────────────────
// Try root node_modules, then x402 node_modules as fallback.

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

function loadWeb3() {
  const req = createRequire(import.meta.url);
  for (const candidate of [
    "@solana/web3.js",
    join(ROOT, "node_modules", "@solana", "web3.js"),
    join(ROOT, "x402", "node_modules", "@solana", "web3.js"),
  ]) {
    try { return req(candidate); } catch { /* try next */ }
  }
  throw new Error(
    "@solana/web3.js not found.\n" +
    "  Run:  npm install           (at workspace root)\n" +
    "  Or:   npm install --prefix x402"
  );
}

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const MESSAGE = process.env.MESSAGE ?? "DARKNULL";
const EPOCH   = BigInt(process.env.EPOCH ?? "0");
const DRY_RUN = process.env.DRY_RUN === "true";

// Must match programs/dark_nullifier_banks/src/lib.rs: pub const DOMAIN = b"dark_null_v1"
const DOMAIN = Buffer.from("dark_null_v1", "utf8");

// PDA seeds (must match program constants exactly)
const BANK_SEED     = Buffer.from("null_bank",    "utf8");
const NULL_REC_SEED = Buffer.from("null_rec",     "utf8");
const ROOT_SEED     = Buffer.from("receipt_root", "utf8");
const BATCH_SEED    = Buffer.from("chaff_batch",  "utf8");
const INTENT_SEED   = Buffer.from("chaff_intent", "utf8");

const SOLSCAN = (sig: string | null) =>
  sig && !sig.startsWith("ERROR") && !sig.startsWith("(dry")
    ? `https://solscan.io/tx/${sig}?cluster=devnet`
    : "#";

// ── bank_index (mirrors Rust exactly) ────────────────────────────────────────
//
//   bank_index(nullifier, epoch, domain) =
//       SHA256(nullifier || epoch_le64 || domain)[0]
//
// Matches: hashv(&[nullifier, &epoch.to_le_bytes(), domain]).to_bytes()[0]
// in programs/dark_nullifier_banks/src/processor.rs

function bankIndex(nullifier: Uint8Array, epoch: bigint): number {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  return createHash("sha256")
    .update(Buffer.from(nullifier))
    .update(epochBuf)
    .update(DOMAIN)
    .digest()[0];
}

// ── Brute-force ───────────────────────────────────────────────────────────────

function findNullifierForShard(
  targetShard: number,
  epoch: bigint
): { nullifier: Buffer; attempts: number } {
  let attempts = 0;
  while (true) {
    const nullifier = randomBytes(32);
    attempts++;
    if (bankIndex(nullifier, epoch) === targetShard) {
      return { nullifier, attempts };
    }
  }
}

// ── Instruction data builders ─────────────────────────────────────────────────

function initBankData(shard: number, epoch: bigint): Buffer {
  const buf = Buffer.alloc(10);
  buf[0] = 0x00;
  buf[1] = shard;
  buf.writeBigUInt64LE(epoch, 2);
  return buf;
}

function insertNullifierData(nullifier: Buffer, epoch: bigint): Buffer {
  const buf = Buffer.alloc(41);
  buf[0] = 0x01;
  nullifier.copy(buf, 1);
  buf.writeBigUInt64LE(epoch, 33);
  return buf;
}

function updateRootData(root: Buffer): Buffer {
  const buf = Buffer.alloc(33);
  buf[0] = 0x01;
  root.copy(buf, 1);
  return buf;
}

function createChaffData(count: number, epoch: bigint): Buffer {
  const buf = Buffer.alloc(10);
  buf[0] = 0x00;
  buf[1] = count;
  buf.writeBigUInt64LE(epoch, 2);
  return buf;
}

function closeChaffData(epoch: bigint): Buffer {
  const buf = Buffer.alloc(9);
  buf[0] = 0x01;
  buf.writeBigUInt64LE(epoch, 1);
  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface EvidenceEntry {
  char: string;
  ascii: number;
  shard: number;
  nullifier: string;
  attempts: number;
  bankPda: string;
  nullRecPda: string;
  initBankTxSig: string | null;
  insertTxSig: string | null;
}

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   Dark Null Devnet Ritual Evidence Generator   ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  if (DRY_RUN) {
    console.log("⚠️  DRY RUN — shard search runs, no transactions submitted\n");
  }

  // ── Load @solana/web3.js ────────────────────────────────────────────────────
  let web3: any;
  try {
    web3 = loadWeb3();
  } catch (e: any) {
    blocker(e.message);
  }

  const {
    Connection, Keypair, PublicKey, Transaction,
    TransactionInstruction, SystemProgram,
    sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  } = web3;

  // ── Load keypair ────────────────────────────────────────────────────────────
  const keyPath = process.env.SOLANA_KEYPAIR_PATH ??
    join(homedir(), ".config", "solana", "id.json");
  if (!existsSync(keyPath)) {
    blocker(
      `Keypair not found at ${keyPath}\n` +
      "  Run:  solana-keygen new\n" +
      `  Then: solana airdrop 2 <pubkey> --url devnet`
    );
  }
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(keyPath, "utf8")))
  );

  // ── Load program IDs ────────────────────────────────────────────────────────
  const nullifierBanksId     = requireProgramId(PublicKey, "DARK_NULLIFIER_BANKS_ID",     "dark_nullifier_banks");
  const compressedReceiptsId = requireProgramId(PublicKey, "DARK_COMPRESSED_RECEIPTS_ID", "dark_compressed_receipts");
  const chaffId              = requireProgramId(PublicKey, "DARK_CHAFF_ID",               "dark_chaff");

  // ── Connect ─────────────────────────────────────────────────────────────────
  const conn = new Connection(RPC_URL, "confirmed");

  console.log(`Payer:   ${payer.publicKey.toString()}`);
  console.log(`RPC:     ${RPC_URL}`);
  console.log(`Message: "${MESSAGE}"`);
  console.log(`Epoch:   ${EPOCH}`);
  console.log(`Domain:  "${DOMAIN.toString("utf8")}"`);
  console.log(`\nPrograms:`);
  console.log(`  dark_nullifier_banks:     ${nullifierBanksId.toString()}`);
  console.log(`  dark_compressed_receipts: ${compressedReceiptsId.toString()}`);
  console.log(`  dark_chaff:               ${chaffId.toString()}`);

  if (!DRY_RUN) {
    const balance = await conn.getBalance(payer.publicKey);
    console.log(`\nBalance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      blocker(
        `Balance too low (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL)\n` +
        `  Run: solana airdrop 2 ${payer.publicKey.toString()} --url devnet`
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Encode message via nullifier shards
  // ════════════════════════════════════════════════════════════════════════════

  console.log("\n── Phase 1: Shard-encoding \"" + MESSAGE + "\" ─────────────────────────────");
  const evidenceEntries: EvidenceEntry[] = [];
  const initializedBanks = new Set<number>();

  for (let i = 0; i < MESSAGE.length; i++) {
    const char  = MESSAGE[i];
    const ascii = MESSAGE.charCodeAt(i);
    const shard = ascii; // by design: target shard == ASCII code

    console.log(`\n[${i + 1}/${MESSAGE.length}] '${char}' (ASCII ${ascii})`);

    // Brute-force
    process.stdout.write("  Searching for nullifier...");
    const { nullifier, attempts } = findNullifierForShard(shard, EPOCH);
    console.log(` found in ${attempts} attempts`);

    // PDA addresses
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(EPOCH);

    const [bankAddr] = await PublicKey.findProgramAddress(
      [BANK_SEED, Buffer.from([shard]), epochBuf],
      nullifierBanksId
    );
    const [recAddr] = await PublicKey.findProgramAddress(
      [NULL_REC_SEED, Buffer.from([shard]), nullifier],
      nullifierBanksId
    );
    console.log(`  Bank PDA:    ${bankAddr.toString()}`);
    console.log(`  NullRec PDA: ${recAddr.toString()}`);

    let initBankSig: string | null = null;
    let insertSig:   string | null = null;

    if (!DRY_RUN) {
      // Init bank (once per shard per run)
      if (!initializedBanks.has(shard)) {
        const bankInfo = await conn.getAccountInfo(bankAddr);
        if (!bankInfo) {
          try {
            const tx = new Transaction().add(
              new TransactionInstruction({
                programId: nullifierBanksId,
                keys: [
                  { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
                  { pubkey: bankAddr,        isSigner: false, isWritable: true  },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                data: initBankData(shard, EPOCH),
              })
            );
            initBankSig = await sendAndConfirmTransaction(conn, tx, [payer]);
            console.log(`  InitBank tx: ${initBankSig}`);
          } catch (e: any) {
            console.warn(`  InitBank: ${e.message}`);
          }
        } else {
          console.log("  Bank already initialized");
        }
        initializedBanks.add(shard);
      }

      // Insert nullifier
      try {
        const tx = new Transaction().add(
          new TransactionInstruction({
            programId: nullifierBanksId,
            keys: [
              { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
              { pubkey: bankAddr,        isSigner: false, isWritable: true  },
              { pubkey: recAddr,         isSigner: false, isWritable: true  },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: insertNullifierData(nullifier, EPOCH),
          })
        );
        insertSig = await sendAndConfirmTransaction(conn, tx, [payer]);
        console.log(`  InsertNullifier: ${insertSig}`);
        console.log(`  Solscan: https://solscan.io/tx/${insertSig}?cluster=devnet`);
      } catch (e: any) {
        insertSig = `ERROR: ${e.message}`;
        console.error(`  InsertNullifier FAILED: ${e.message}`);
      }
    } else {
      insertSig = "(dry-run)";
    }

    evidenceEntries.push({
      char, ascii, shard,
      nullifier: nullifier.toString("hex"),
      attempts,
      bankPda:    bankAddr.toString(),
      nullRecPda: recAddr.toString(),
      initBankTxSig: initBankSig,
      insertTxSig:   insertSig,
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 2 — Receipt root update
  // ════════════════════════════════════════════════════════════════════════════

  console.log("\n── Phase 2: Receipt root ───────────────────────────────────────────");

  const messageHash = createHash("sha256").update(MESSAGE, "utf8").digest();
  const prevRoot    = Buffer.alloc(32, 0);
  const receiptRoot = createHash("sha256")
    .update("DARK_NULL_RITUAL")
    .update(messageHash)
    .update(prevRoot)
    .digest();

  console.log(`  Message hash: ${messageHash.toString("hex")}`);
  console.log(`  Receipt root: ${receiptRoot.toString("hex")}`);

  const [rootAddr] = await PublicKey.findProgramAddress(
    [ROOT_SEED, payer.publicKey.toBuffer()],
    compressedReceiptsId
  );
  console.log(`  Root PDA:     ${rootAddr.toString()}`);

  let initRootSig:   string | null = DRY_RUN ? "(dry-run)" : null;
  let updateRootSig: string | null = DRY_RUN ? "(dry-run)" : null;

  if (!DRY_RUN) {
    // InitRoot if needed
    const rootInfo = await conn.getAccountInfo(rootAddr);
    if (!rootInfo) {
      try {
        const tx = new Transaction().add(
          new TransactionInstruction({
            programId: compressedReceiptsId,
            keys: [
              { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
              { pubkey: rootAddr,        isSigner: false, isWritable: true  },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([0x00]),
          })
        );
        initRootSig = await sendAndConfirmTransaction(conn, tx, [payer]);
        console.log(`  InitRoot tx:   ${initRootSig}`);
      } catch (e: any) {
        initRootSig = `ERROR: ${e.message}`;
        console.error(`  InitRoot FAILED: ${e.message}`);
      }
    } else {
      console.log("  Root already initialized");
      initRootSig = "(pre-existing)";
    }

    // UpdateRoot
    try {
      const tx = new Transaction().add(
        new TransactionInstruction({
          programId: compressedReceiptsId,
          keys: [
            { pubkey: payer.publicKey, isSigner: true,  isWritable: false },
            { pubkey: rootAddr,        isSigner: false, isWritable: true  },
          ],
          data: updateRootData(receiptRoot),
        })
      );
      updateRootSig = await sendAndConfirmTransaction(conn, tx, [payer]);
      console.log(`  UpdateRoot tx: ${updateRootSig}`);
      console.log(`  Solscan: https://solscan.io/tx/${updateRootSig}?cluster=devnet`);
    } catch (e: any) {
      updateRootSig = `ERROR: ${e.message}`;
      console.error(`  UpdateRoot FAILED: ${e.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 3 — Chaff PDAs
  // ════════════════════════════════════════════════════════════════════════════

  console.log("\n── Phase 3: Chaff PDAs ─────────────────────────────────────────────");

  // Use EPOCH for chaff. The close only rejects FUTURE epochs, so 0 is fine
  // on devnet (current epoch ≈ floor(unix_ts/3600) ≈ 485000+).
  const CHAFF_COUNT = 3;
  const chaffEpoch  = EPOCH;

  const epochBuf8 = Buffer.alloc(8);
  epochBuf8.writeBigUInt64LE(chaffEpoch);

  const [batchAddr] = await PublicKey.findProgramAddress(
    [BATCH_SEED, payer.publicKey.toBuffer(), epochBuf8],
    chaffId
  );
  const intentAddrs: any[] = [];
  for (let i = 0; i < CHAFF_COUNT; i++) {
    const [a] = await PublicKey.findProgramAddress(
      [INTENT_SEED, epochBuf8, Buffer.from([i])],
      chaffId
    );
    intentAddrs.push(a);
  }
  console.log(`  Batch PDA: ${batchAddr.toString()}`);

  let chaffCreateSig: string | null = DRY_RUN ? "(dry-run)" : null;
  let chaffCloseSig:  string | null = DRY_RUN ? "(dry-run)" : null;

  if (!DRY_RUN) {
    try {
      const createTx = new Transaction().add(
        new TransactionInstruction({
          programId: chaffId,
          keys: [
            { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
            { pubkey: batchAddr,       isSigner: false, isWritable: true  },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ...intentAddrs.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })),
          ],
          data: createChaffData(CHAFF_COUNT, chaffEpoch),
        })
      );
      chaffCreateSig = await sendAndConfirmTransaction(conn, createTx, [payer]);
      console.log(`  CreateChaffBatch: ${chaffCreateSig}`);

      const closeTx = new Transaction().add(
        new TransactionInstruction({
          programId: chaffId,
          keys: [
            { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
            { pubkey: batchAddr,       isSigner: false, isWritable: true  },
            ...intentAddrs.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })),
          ],
          data: closeChaffData(chaffEpoch),
        })
      );
      chaffCloseSig = await sendAndConfirmTransaction(conn, closeTx, [payer]);
      console.log(`  CloseChaffBatch:  ${chaffCloseSig}`);
    } catch (e: any) {
      const msg = `ERROR: ${e.message}`;
      chaffCreateSig ??= msg;
      chaffCloseSig  ??= msg;
      console.error(`  Chaff FAILED: ${e.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 4 — Generate evidence document
  // ════════════════════════════════════════════════════════════════════════════

  console.log("\n── Phase 4: Writing evidence document ──────────────────────────────");

  const asciiTable = evidenceEntries
    .map(
      (e) =>
        `| \`${e.char}\` | ${e.ascii} | ${e.shard} | \`${e.nullifier.slice(0, 16)}…\` | ${e.attempts} | ` +
        `[tx](${SOLSCAN(e.insertTxSig)}) |`
    )
    .join("\n");

  const nullifierSections = evidenceEntries
    .map(
      (e, i) =>
        `### Character ${i + 1}: \`'${e.char}'\` (ASCII ${e.ascii})\n\n` +
        `| Field | Value |\n|-------|-------|\n` +
        `| Target shard | \`${e.shard}\` |\n` +
        `| Nullifier (hex) | \`${e.nullifier}\` |\n` +
        `| Brute-force attempts | ${e.attempts} |\n` +
        `| Bank PDA | \`${e.bankPda}\` |\n` +
        `| NullRec PDA | \`${e.nullRecPda}\` |\n` +
        (e.initBankTxSig
          ? `| InitBank tx | [Solscan](${SOLSCAN(e.initBankTxSig)}) |\n`
          : "") +
        `| InsertNullifier tx | [Solscan](${SOLSCAN(e.insertTxSig)}) |\n`
    )
    .join("\n");

  const doc = `# Dark Null Devnet Ritual — Shard Message Evidence

> **Message encoded:** \`${MESSAGE}\`
> **Network:** Solana Devnet
> **Epoch:** \`${EPOCH}\`
> **Domain:** \`${DOMAIN.toString("utf8")}\`
> **Generated:** ${new Date().toISOString()}
> **Mode:** ${DRY_RUN ? "⚠️ DRY RUN — no transactions submitted" : "✅ LIVE — real devnet transactions"}

---

## What This Proves

Each character of \`${MESSAGE}\` is encoded by submitting a nullifier to the shard whose index
equals the ASCII code of that character.

**The shard is determined by the \`bank_index\` function:**

\`\`\`
bank_index(nullifier, epoch, domain) = SHA256(nullifier || epoch_le64 || domain)[0]
\`\`\`

Where:
- \`nullifier\` = random 32 bytes (brute-forced until first hash byte = target shard)
- \`epoch_le64\` = \`${EPOCH}\` encoded as 8-byte little-endian
- \`domain\` = \`"${DOMAIN.toString("utf8")}"\` (UTF-8 bytes, matches program constant)
- Result = first byte of SHA-256 output (0–255)

The prover must search random nullifiers until the hash lands on the correct shard. Average: **~256 attempts per character**. Each nullifier is permanently locked on-chain by the \`dark_nullifier_banks\` program — the PDA seed \`[b"null_rec", shard, nullifier]\` prevents re-submission.

---

## Deployed Programs

| Program | Program ID |
|---------|-----------|
| \`dark_nullifier_banks\` | \`${nullifierBanksId.toString()}\` |
| \`dark_compressed_receipts\` | \`${compressedReceiptsId.toString()}\` |
| \`dark_chaff\` | \`${chaffId.toString()}\` |

[View dark_nullifier_banks on Solscan](https://solscan.io/account/${nullifierBanksId.toString()}?cluster=devnet)
[View dark_compressed_receipts on Solscan](https://solscan.io/account/${compressedReceiptsId.toString()}?cluster=devnet)
[View dark_chaff on Solscan](https://solscan.io/account/${chaffId.toString()}?cluster=devnet)

---

## ASCII Shard Path

| Char | ASCII | Shard | Nullifier (first 8 bytes) | Attempts | InsertNullifier |
|------|-------|-------|--------------------------|----------|----------------|
${asciiTable}

---

## Detailed Nullifier Evidence

${nullifierSections}

---

## Phase 2: Receipt Root

| Field | Value |
|-------|-------|
| Message | \`${MESSAGE}\` |
| Message hash | \`${messageHash.toString("hex")}\` |
| Receipt root | \`${receiptRoot.toString("hex")}\` |
| Root PDA | \`${rootAddr.toString()}\` |
| InitRoot tx | [Solscan](${SOLSCAN(initRootSig)}) |
| UpdateRoot tx | [Solscan](${SOLSCAN(updateRootSig)}) |

**Derivation:**
\`\`\`
message_hash = SHA256("${MESSAGE}")
             = ${messageHash.toString("hex")}

receipt_root = SHA256("DARK_NULL_RITUAL" || message_hash || 0x00...00)
             = ${receiptRoot.toString("hex")}
\`\`\`

---

## Phase 3: Chaff PDAs

| Field | Value |
|-------|-------|
| Chaff count | ${CHAFF_COUNT} |
| Epoch | ${chaffEpoch} |
| Batch PDA | \`${batchAddr.toString()}\` |
| CreateChaffBatch tx | [Solscan](${SOLSCAN(chaffCreateSig)}) |
| CloseChaffBatch tx | [Solscan](${SOLSCAN(chaffCloseSig)}) |

Chaff PDAs are created and immediately closed, reclaiming rent. They exist only to
produce transaction patterns indistinguishable from real protocol activity.

---

## Verification Instructions

### Verify a nullifier shard independently

\`\`\`typescript
import { createHash } from "crypto";

function bankIndex(nullifier: Buffer, epoch: bigint): number {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  const domain = Buffer.from("dark_null_v1", "utf8");
  return createHash("sha256")
    .update(nullifier)
    .update(epochBuf)
    .update(domain)
    .digest()[0];
}

// Example: verify the first character '${MESSAGE[0]}' (ASCII ${MESSAGE.charCodeAt(0)})
const nullifier = Buffer.from("${evidenceEntries[0]?.nullifier ?? "..."}", "hex");
console.assert(bankIndex(nullifier, ${EPOCH}n) === ${MESSAGE.charCodeAt(0)});
\`\`\`

### Verify on-chain via Rust (existing test)

\`\`\`bash
cargo test test_bank_index_deterministic --package dark-nullifier-banks
\`\`\`

### Verify via Solana CLI

\`\`\`bash
# Check the NullRec PDA exists (proof of insertion)
solana account ${evidenceEntries[0]?.nullRecPda ?? "<null_rec_pda>"} --url devnet
\`\`\`

---

## What Is NOT Claimed

- This is **not** a zero-knowledge proof
- The nullifiers encode test message bytes, **not** user financial data
- The receipt root is **deterministically constructed**, not user-generated
- Programs are on **devnet only** — no mainnet deployment
- This is **ritual/evidence**, not production cryptography
`;

  const evidencePath = join(ROOT, "docs", "SHARD_MESSAGE_EVIDENCE.md");
  writeFileSync(evidencePath, doc, "utf8");
  console.log(`\n✅ Evidence written to docs/SHARD_MESSAGE_EVIDENCE.md`);

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE 5 — Update AUDIT.md with real program IDs
  // ════════════════════════════════════════════════════════════════════════════

  const auditPath = join(ROOT, "docs", "AUDIT.md");
  if (existsSync(auditPath)) {
    let audit = readFileSync(auditPath, "utf8");

    const replacements: [RegExp, string][] = [
      [
        /\| `dark_nullifier_banks` \| devnet \| `<!-- PROGRAM_ID -->` \| \[Solscan\]\(<!-- SOLSCAN_TX_URL -->\) \|/,
        `| \`dark_nullifier_banks\` | devnet | \`${nullifierBanksId.toString()}\` | [Solscan](${SOLSCAN(evidenceEntries.find(Boolean)?.insertTxSig ?? null)}) |`,
      ],
      [
        /\| `dark_compressed_receipts` \| devnet \| `<!-- PROGRAM_ID -->` \| \[Solscan\]\(<!-- SOLSCAN_TX_URL -->\) \|/,
        `| \`dark_compressed_receipts\` | devnet | \`${compressedReceiptsId.toString()}\` | [Solscan](${SOLSCAN(updateRootSig)}) |`,
      ],
      [
        /\| `dark_chaff` \| devnet \| `<!-- PROGRAM_ID -->` \| \[Solscan\]\(<!-- SOLSCAN_TX_URL -->\) \|/,
        `| \`dark_chaff\` | devnet | \`${chaffId.toString()}\` | [Solscan](${SOLSCAN(chaffCreateSig)}) |`,
      ],
    ];

    let updated = false;
    for (const [pattern, replacement] of replacements) {
      if (pattern.test(audit)) {
        audit = audit.replace(pattern, replacement);
        updated = true;
      }
    }

    if (updated) {
      writeFileSync(auditPath, audit, "utf8");
      console.log("✅ AUDIT.md program table updated");
    } else {
      console.log("ℹ️  AUDIT.md already has program IDs (or format changed)");
    }
  }

  // ── Final summary ───────────────────────────────────────────────────────────
  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log("║  Ritual complete.                               ║");
  console.log(`║  Message: "${MESSAGE}" encoded in ${evidenceEntries.length} shards.`);
  console.log("║                                                 ║");
  console.log("║  docs/SHARD_MESSAGE_EVIDENCE.md                 ║");
  console.log("║  docs/AUDIT.md (program table updated)          ║");
  console.log("╚═══════════════════════════════════════════════╝\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireProgramId(PublicKey: any, envVar: string, name: string): any {
  const id = process.env[envVar];
  if (!id) {
    blocker(
      `Missing env var: ${envVar}\n\n` +
      `  Deploy ${name} to devnet first:\n` +
      `    cargo build-sbf -p ${name}\n` +
      `    solana program deploy target/deploy/${name}.so --url devnet\n` +
      `  Then:\n` +
      `    export ${envVar}=<program_id>`
    );
  }
  try {
    return new PublicKey(id!);
  } catch {
    blocker(`Invalid public key in ${envVar}: "${id}"`);
  }
}

function blocker(msg: string): never {
  console.error("\n🔥 BLOCKER\n");
  console.error(msg);
  console.error(
    "\n── Full deploy checklist ───────────────────────────────────\n" +
    "  1.  solana-keygen new                               # if no keypair\n" +
    "  2.  solana airdrop 2 <pubkey> --url devnet          # fund it\n" +
    "  3.  npm install                                     # @solana/web3.js\n" +
    "  4.  cargo build-sbf                                 # compile programs\n" +
    "  5.  solana program deploy target/deploy/dark_nullifier_banks.so --url devnet\n" +
    "  6.  solana program deploy target/deploy/dark_compressed_receipts.so --url devnet\n" +
    "  7.  solana program deploy target/deploy/dark_chaff.so --url devnet\n" +
    "  8.  export DARK_NULLIFIER_BANKS_ID=<id>\n" +
    "      export DARK_COMPRESSED_RECEIPTS_ID=<id>\n" +
    "      export DARK_CHAFF_ID=<id>\n" +
    "  9.  npx tsx scripts/devnet-shard-message.ts\n" +
    "      # or with DRY_RUN=true to skip txs\n"
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("\n💥 Unexpected error:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
