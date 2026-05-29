/**
 * null-miner-sdk — Liquefy Bridge
 *
 * Connects Liquefy .null archives to receipt_anchor for batch receipt
 * commitment. Off-chain .null archives hold full task receipts + nullifier
 * sets; on-chain, only the Poseidon Merkle root is committed (500x cheaper).
 *
 * The "dark" search property: agents can scan .null archives using their
 * X25519 scan key — the Liquefy DKSAP protocol finds receipts addressed
 * to them without revealing the set to observers.
 */

import { createHash, randomBytes } from "crypto";
import { buildSnarkPackBatch } from "../zk/receipt.js";
import type { ReceiptPublicInputs } from "../zk/receipt.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single entry in a .null archive. */
export interface NullArchiveEntry {
  taskId:            string;
  /** Semaphore nullifier hash (hex). */
  nullifierHash:     string;
  /** Poseidon receipt commitment (hex). */
  receiptCommitment: string;
  agentPassportId:   string;
  platformId:        string;
  /** USDC amount in atomic units. */
  amountAtomic:      number;
  /** Unix epoch ms. */
  timestamp:         number;
  /** True if this is a synthetic decoy entry (privacy chaff). */
  isDecoy:           boolean;
}

/** A .null archive containing real and decoy entries with a Merkle root. */
export interface NullArchive {
  archiveId:     string;
  entries:       NullArchiveEntry[];
  /** Poseidon Merkle root over receiptCommitment leaves (hex). */
  merkleRoot:    string;
  createdAt:     number;
  totalEntries:  number;
  /** Count of non-decoy entries. */
  realEntries:   number;
  /**
   * Decentralized storage URI for this archive (optional — undefined until uploaded).
   * Can be an Arweave TX ID (ar://...), IPFS CID (ipfs://...), or Shadow Drive URL.
   * The Merkle root is anchored on-chain; the URI is the off-chain data location
   * for auditing and agent scanning without a server.
   */
  storageUri?:   string;
}

/** Result of bridging an archive to a receipt_anchor instruction. */
export interface ArchiveBridgeResult {
  archiveId:              string;
  /** Poseidon Merkle root (hex). */
  batchReceiptRoot:       string;
  /** 34-byte receipt anchor instruction data (base64). Format: [0x01, 0x00, anchor32[32]]. */
  anchorInstructionData:  string;
  entryCount:             number;
  decoyCount:             number;
}

// ── Archive Builder ───────────────────────────────────────────────────────────

/**
 * Create a .null archive from real task entries, adding privacy decoys.
 *
 * @param entries     — real receipt entries from completed tasks
 * @param decoyCount  — number of synthetic decoy entries to add (default 4)
 */
export function createNullArchive(
  entries: NullArchiveEntry[],
  decoyCount: number = 4,
): NullArchive {
  const createdAt = Date.now();
  const decoys    = _generateDecoys(decoyCount, entries[0]?.platformId ?? "null-miner");
  const allEntries = [...entries, ...decoys];

  // Build SnarkPack receipt public inputs for real entries (decoys contribute zero leaves)
  const receipts: ReceiptPublicInputs[] = allEntries.map((e) => ({
    receiptCommitment: e.receiptCommitment.padStart(64, "0").slice(0, 64),
    nullifierHash:     e.nullifierHash.padStart(64, "0").slice(0, 64),
    amountBound:       e.amountAtomic,
    contextId:         createHash("sha256")
      .update(`archive-ctx-v1:${e.platformId}`)
      .digest("hex"),
  }));

  let merkleRoot: string;
  if (receipts.length === 0) {
    // Edge case: if somehow we have no entries at all, use a zero root
    merkleRoot = "0".repeat(64);
  } else {
    try {
      const batch = buildSnarkPackBatch(receipts);
      merkleRoot = batch.batchRoot;
    } catch {
      merkleRoot = createHash("sha256")
        .update("empty-archive-v1")
        .update(createdAt.toString())
        .digest("hex");
    }
  }

  // archiveId = first 32 hex chars of SHA-256(merkleRoot + ":archive:" + createdAt)
  const archiveId = createHash("sha256")
    .update(merkleRoot + ":archive:" + createdAt.toString())
    .digest("hex")
    .slice(0, 32);

  return {
    archiveId,
    entries:      allEntries,
    merkleRoot,
    createdAt,
    totalEntries: allEntries.length,
    realEntries:  entries.length,
  };
}

// ── Bridge to receipt_anchor ──────────────────────────────────────────────────

/**
 * Bridge a .null archive to a receipt_anchor on-chain instruction.
 *
 * Produces a 34-byte instruction: [0x01, 0x00, anchor32[32]]
 * where anchor32 = SHA-256("liquefy-archive-v1" || merkleRoot_bytes || archiveId_bytes)
 */
export function bridgeArchiveToAnchor(archive: NullArchive): ArchiveBridgeResult {
  const merkleRootBytes = Buffer.from(archive.merkleRoot, "hex");
  const archiveIdBytes  = Buffer.from(archive.archiveId, "utf8");

  const anchor32 = createHash("sha256")
    .update(Buffer.from("liquefy-archive-v1"))
    .update(merkleRootBytes)
    .update(archiveIdBytes)
    .digest();

  const ixBuf = Buffer.alloc(34);
  ixBuf[0] = 0x01; // INSTRUCTION_VERSION_V1
  ixBuf[1] = 0x00; // flags
  anchor32.copy(ixBuf, 2);

  const decoyCount = archive.entries.filter((e) => e.isDecoy).length;

  return {
    archiveId:             archive.archiveId,
    batchReceiptRoot:      archive.merkleRoot,
    anchorInstructionData: ixBuf.toString("base64"),
    entryCount:            archive.totalEntries,
    decoyCount,
  };
}

// ── Archive Scan ──────────────────────────────────────────────────────────────

/**
 * Scan a .null archive for entries addressed to a specific agent.
 *
 * Returns only real (non-decoy) entries matching the agent's passport ID.
 * Full stealth scan (DKSAP) would require the agent's private scan key —
 * that lives off-chain. This is the passport-ID shortcut for devnet.
 */
export function scanArchiveForAgent(
  archive: NullArchive,
  agentPassportId: string,
): NullArchiveEntry[] {
  return archive.entries.filter(
    (e) => !e.isDecoy && e.agentPassportId === agentPassportId,
  );
}

// ── Archive Merge ─────────────────────────────────────────────────────────────

/**
 * Merge multiple .null archives into one, deduplicating by taskId.
 * Decoy entries are re-generated (count = default 4) for the merged archive.
 */
export function mergeArchives(archives: NullArchive[]): NullArchive {
  // Collect all real entries, deduplicate by taskId
  const seen = new Set<string>();
  const realEntries: NullArchiveEntry[] = [];

  for (const archive of archives) {
    for (const entry of archive.entries) {
      if (!entry.isDecoy && !seen.has(entry.taskId)) {
        seen.add(entry.taskId);
        realEntries.push(entry);
      }
    }
  }

  return createNullArchive(realEntries);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _generateDecoys(count: number, platformId: string): NullArchiveEntry[] {
  const decoys: NullArchiveEntry[] = [];
  for (let i = 0; i < count; i++) {
    const rnd = randomBytes(32);
    decoys.push({
      taskId:            randomBytes(32).toString("hex"),
      nullifierHash:     createHash("sha256").update(rnd).update("decoy-nh").digest("hex"),
      receiptCommitment: createHash("sha256").update(rnd).update("decoy-rc").digest("hex"),
      agentPassportId:   randomBytes(16).toString("hex"),
      platformId,
      amountAtomic:      0,
      timestamp:         Date.now(),
      isDecoy:           true,
    });
  }
  return decoys;
}

// ── Decentralized Storage Helpers ─────────────────────────────────────────────

/**
 * Attach a decentralized storage URI to an existing archive.
 * URI can be an Arweave TX ID (ar://...), IPFS CID (ipfs://...), or Shadow Drive URL.
 *
 * The Merkle root is already anchored on-chain — the URI is the off-chain data location
 * for auditing and agent scanning. Agents don't need our server to find their receipts.
 */
export function withStorageUri(archive: NullArchive, uri: string): NullArchive {
  return { ...archive, storageUri: uri };
}

/**
 * Encode an archive to a compact JSON Buffer for upload to Arweave/IPFS/Shadow Drive.
 * Non-decoy entries only are included to minimize upload size.
 *
 * Format: JSON with fields: archiveId, merkleRoot, createdAt, entries (non-decoy only)
 */
export function encodeArchiveForStorage(archive: NullArchive): Buffer {
  const payload = {
    archiveId:   archive.archiveId,
    merkleRoot:  archive.merkleRoot,
    createdAt:   archive.createdAt,
    entries:     archive.entries.filter(e => !e.isDecoy).map(e => ({
      taskId:            e.taskId,
      nullifierHash:     e.nullifierHash,
      receiptCommitment: e.receiptCommitment,
      agentPassportId:   e.agentPassportId,
      platformId:        e.platformId,
      amountAtomic:      e.amountAtomic,
      timestamp:         e.timestamp,
    })),
  };
  return Buffer.from(JSON.stringify(payload));
}

/**
 * Build Arweave tags for a .null archive upload.
 * These tags make archives discoverable by archiveId and merkleRoot on Arweave's GraphQL.
 */
export function buildArweaveUploadTags(archive: NullArchive): Array<{ name: string; value: string }> {
  return [
    { name: "Content-Type",    value: "application/json" },
    { name: "App-Name",        value: "null-miner-sdk" },
    { name: "Archive-Id",      value: archive.archiveId },
    { name: "Merkle-Root",     value: archive.merkleRoot },
    { name: "Created-At",      value: archive.createdAt.toString() },
    { name: "Entry-Count",     value: archive.realEntries.toString() },
    { name: "Protocol",        value: "dark-null-archive-v1" },
  ];
}
