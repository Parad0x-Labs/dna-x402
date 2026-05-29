/**
 * null-miner-sdk — Liquefy Bridge Tests
 *
 * Tests for NullArchive, bridge-to-anchor, and decentralized storage helpers.
 */

import {
  createNullArchive,
  bridgeArchiveToAnchor,
  withStorageUri,
  encodeArchiveForStorage,
  buildArweaveUploadTags,
} from "../src/liquefy/bridge.js";
import type { NullArchiveEntry, NullArchive } from "../src/liquefy/bridge.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(i: number): NullArchiveEntry {
  return {
    taskId:            `${"a".repeat(60)}${i.toString().padStart(4, "0")}`,
    nullifierHash:     `${"b".repeat(60)}${i.toString().padStart(4, "0")}`,
    receiptCommitment: `${"c".repeat(60)}${i.toString().padStart(4, "0")}`,
    agentPassportId:   `passport-${i}`,
    platformId:        "test-platform",
    amountAtomic:      1000 * (i + 1),
    timestamp:         1_700_000_000_000 + i * 1000,
    isDecoy:           false,
  };
}

function makeArchive(realCount = 2, decoyCount = 2): NullArchive {
  const entries = Array.from({ length: realCount }, (_, i) => makeEntry(i));
  return createNullArchive(entries, decoyCount);
}

// ── Core archive tests ────────────────────────────────────────────────────────

describe("NullArchive basics", () => {
  test("createNullArchive returns correct real entry count", () => {
    const archive = makeArchive(3, 4);
    expect(archive.realEntries).toBe(3);
  });

  test("createNullArchive adds requested decoy count", () => {
    const archive = makeArchive(2, 4);
    const decoys  = archive.entries.filter(e => e.isDecoy);
    expect(decoys.length).toBe(4);
  });

  test("bridgeArchiveToAnchor produces 34-byte base64 instruction", () => {
    const archive = makeArchive();
    const result  = bridgeArchiveToAnchor(archive);
    const ixBuf   = Buffer.from(result.anchorInstructionData, "base64");
    expect(ixBuf.length).toBe(34);
    expect(ixBuf[0]).toBe(0x01);
    expect(ixBuf[1]).toBe(0x00);
  });
});

// ── Storage helpers ───────────────────────────────────────────────────────────

describe("Storage helpers", () => {
  test("withStorageUri: attaches URI to archive", () => {
    const archive  = makeArchive();
    const uri      = "ar://someTransactionId";
    const updated  = withStorageUri(archive, uri);
    expect(updated.storageUri).toBe(uri);
  });

  test("withStorageUri: does not mutate original archive", () => {
    const archive = makeArchive();
    expect(archive.storageUri).toBeUndefined();
    withStorageUri(archive, "ar://test");
    expect(archive.storageUri).toBeUndefined();
  });

  test("encodeArchiveForStorage: returns Buffer", () => {
    const archive = makeArchive();
    const buf     = encodeArchiveForStorage(archive);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test("encodeArchiveForStorage: excludes decoy entries", () => {
    const archive  = makeArchive(2, 4); // 2 real, 4 decoys
    const buf      = encodeArchiveForStorage(archive);
    const payload  = JSON.parse(buf.toString("utf-8")) as { entries: unknown[] };
    expect(payload.entries.length).toBe(2);
  });

  test("encodeArchiveForStorage: JSON parseable", () => {
    const archive = makeArchive();
    const buf     = encodeArchiveForStorage(archive);
    expect(() => JSON.parse(buf.toString("utf-8"))).not.toThrow();
  });

  test("encodeArchiveForStorage: contains merkleRoot", () => {
    const archive  = makeArchive();
    const buf      = encodeArchiveForStorage(archive);
    const payload  = JSON.parse(buf.toString("utf-8")) as { merkleRoot: string };
    expect(payload.merkleRoot).toBe(archive.merkleRoot);
  });

  test("buildArweaveUploadTags: returns array of name/value pairs", () => {
    const archive = makeArchive();
    const tags    = buildArweaveUploadTags(archive);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(typeof tag.name).toBe("string");
      expect(typeof tag.value).toBe("string");
    }
  });

  test("buildArweaveUploadTags: includes Archive-Id tag", () => {
    const archive = makeArchive();
    const tags    = buildArweaveUploadTags(archive);
    const tag     = tags.find(t => t.name === "Archive-Id");
    expect(tag).toBeDefined();
    expect(tag!.value).toBe(archive.archiveId);
  });

  test("buildArweaveUploadTags: includes Merkle-Root tag", () => {
    const archive = makeArchive();
    const tags    = buildArweaveUploadTags(archive);
    const tag     = tags.find(t => t.name === "Merkle-Root");
    expect(tag).toBeDefined();
    expect(tag!.value).toBe(archive.merkleRoot);
  });
});
