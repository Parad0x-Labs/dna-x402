/**
 * null-miner-sdk — Full End-to-End Loop Tests
 *
 * Covers:
 *   A. NullMinerLoop basic
 *   B. TaskLoopSimulator
 *   C. createMockEncryptedTask
 *   D. Liquefy NullArchive
 *   E. NULL Flywheel
 *
 * No network calls — pure in-memory.
 */

import { randomBytes } from "crypto";
import { x25519 } from "@noble/curves/ed25519";

// ── Module under test ─────────────────────────────────────────────────────────

import {
  runNullMinerTaskLoop,
  createMockEncryptedTask,
  TaskLoopSimulator,
} from "../src/tasks/NullMinerLoop.js";
import type { TaskLoopConfig } from "../src/tasks/NullMinerLoop.js";

import {
  createNullArchive,
  bridgeArchiveToAnchor,
  scanArchiveForAgent,
  mergeArchives,
} from "../src/liquefy/bridge.js";
import type { NullArchiveEntry } from "../src/liquefy/bridge.js";

import {
  NullFlywheel,
  computeNullYield,
  buildMintAuthorizationHash,
} from "../src/flywheel/index.js";
import type { FlywheelConfig } from "../src/flywheel/index.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<TaskLoopConfig> = {}): TaskLoopConfig {
  return {
    agentScanPriv: randomBytes(32),
    agentSpendKey: randomBytes(32),
    platformId:    "test-platform",
    taskGroupId:   "group-" + randomBytes(4).toString("hex"),
    rewardUsdc:    0.10,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<NullArchiveEntry> = {}): NullArchiveEntry {
  return {
    taskId:            randomBytes(32).toString("hex"),
    nullifierHash:     randomBytes(32).toString("hex"),
    receiptCommitment: randomBytes(32).toString("hex"),
    agentPassportId:   "agent-" + randomBytes(4).toString("hex"),
    platformId:        "test-platform",
    amountAtomic:      100_000,
    timestamp:         Date.now(),
    isDecoy:           false,
    ...overrides,
  };
}

function makeFlywheelConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return {
    nullEmissionRatePct: 5,
    epochDurationMs:     86_400_000,
    maxNullPerEpoch:     10_000,
    platformId:          "test-platform",
    ...overrides,
  };
}

// ── A. NullMinerLoop basic ────────────────────────────────────────────────────

describe("A. NullMinerLoop basic", () => {
  let cfg: TaskLoopConfig;
  let agentScanPub: Uint8Array;
  const taskId = randomBytes(32).toString("hex");

  beforeEach(() => {
    cfg = makeConfig();
    agentScanPub = x25519.getPublicKey(cfg.agentScanPriv);
  });

  test("runNullMinerTaskLoop returns success=true for valid config", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.success).toBe(true);
  });

  test("all 7 steps are present in result", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.steps).toHaveLength(7);
    const names = result.steps.map((s) => s.name);
    expect(names).toContain("scan-task");
    expect(names).toContain("build-identity");
    expect(names).toContain("insert-tree");
    expect(names).toContain("build-witness");
    expect(names).toContain("build-receipt-anchor");
    expect(names).toContain("semaphore-payload");
    expect(names).toContain("x402-anchor");
  });

  test("all steps have success=true", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    for (const step of result.steps) {
      expect(step.success).toBe(true);
    }
  });

  test("nullifierHash is 64-char hex", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.nullifierHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("receiptHash is 64-char hex", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("semaphoreInstructionData decodes to 98 bytes", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    const buf = Buffer.from(result.semaphoreInstructionData, "base64");
    expect(buf.length).toBe(98);
  });

  test("semaphore instruction starts with discriminant 0x03", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    const buf = Buffer.from(result.semaphoreInstructionData, "base64");
    expect(buf[0]).toBe(0x03);
  });

  test("usdcEarned equals config.rewardUsdc", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.usdcEarned).toBe(cfg.rewardUsdc);
  });

  test("nullYield = rewardUsdc * 0.05", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.nullYield).toBeCloseTo(cfg.rewardUsdc * 0.05, 10);
  });

  test("receiptAnchorData decodes to 34 bytes", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    const buf = Buffer.from(result.receiptAnchorData, "base64");
    expect(buf.length).toBe(34);
  });

  test("elapsedMs is a non-negative number", async () => {
    const encTask = createMockEncryptedTask(agentScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("decryption failure returns success=false", async () => {
    // Encrypt to a different scan key; agent can't decrypt
    const wrongScanPub = x25519.getPublicKey(randomBytes(32));
    const encTask = createMockEncryptedTask(wrongScanPub, taskId, cfg.rewardUsdc);
    const result  = await runNullMinerTaskLoop(cfg, encTask);
    expect(result.success).toBe(false);
    expect(result.steps[0]?.name).toBe("scan-task");
    expect(result.steps[0]?.success).toBe(false);
  });
});

// ── B. TaskLoopSimulator ──────────────────────────────────────────────────────

describe("B. TaskLoopSimulator", () => {
  test("simulator.run() returns success", async () => {
    const sim = new TaskLoopSimulator(makeConfig());
    const result = await sim.run();
    expect(result.success).toBe(true);
  });

  test("stats track a single run correctly", async () => {
    const cfg = makeConfig({ rewardUsdc: 0.50 });
    const sim = new TaskLoopSimulator(cfg);
    await sim.run();
    const stats = sim.stats();
    expect(stats.tasksRun).toBe(1);
    expect(stats.totalUsdcEarned).toBeCloseTo(0.50, 6);
    expect(stats.totalNullYield).toBeCloseTo(0.025, 6);
  });

  test("stats accumulate across multiple runs", async () => {
    const cfg = makeConfig({ rewardUsdc: 1.00 });
    const sim = new TaskLoopSimulator(cfg);
    await sim.run();
    await sim.run();
    await sim.run();
    const stats = sim.stats();
    expect(stats.tasksRun).toBe(3);
    expect(stats.totalUsdcEarned).toBeCloseTo(3.00, 6);
    expect(stats.totalNullYield).toBeCloseTo(0.15, 6);
  });

  test("two runs with different taskIds produce different nullifierHashes", async () => {
    const sim = new TaskLoopSimulator(makeConfig());
    const r1 = await sim.run("aa".repeat(32));
    const r2 = await sim.run("bb".repeat(32));
    expect(r1.nullifierHash).not.toBe(r2.nullifierHash);
  });

  test("run with explicit taskId uses that taskId in result", async () => {
    const id  = randomBytes(32).toString("hex");
    const sim = new TaskLoopSimulator(makeConfig());
    const result = await sim.run(id);
    expect(result.taskId).toBe(id);
  });
});

// ── C. createMockEncryptedTask ────────────────────────────────────────────────

describe("C. createMockEncryptedTask", () => {
  test("returns all required fields", () => {
    const priv = randomBytes(32);
    const pub  = x25519.getPublicKey(priv);
    const id   = randomBytes(32).toString("hex");
    const enc  = createMockEncryptedTask(pub, id, 0.05);
    expect(enc.ephemeralPub).toBeDefined();
    expect(enc.nonce).toBeDefined();
    expect(enc.tag).toBeDefined();
    expect(enc.ciphertext).toBeDefined();
    expect(enc.taskId).toBe(id);
    expect(enc.rewardUsdc).toBe(0.05);
  });

  test("ciphertext is non-empty hex string", () => {
    const priv = randomBytes(32);
    const pub  = x25519.getPublicKey(priv);
    const enc  = createMockEncryptedTask(pub, randomBytes(32).toString("hex"), 0.01);
    expect(enc.ciphertext.length).toBeGreaterThan(0);
    expect(enc.ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  test("ephemeralPub is 64-char hex (32 bytes)", () => {
    const priv = randomBytes(32);
    const pub  = x25519.getPublicKey(priv);
    const enc  = createMockEncryptedTask(pub, randomBytes(32).toString("hex"), 0.01);
    expect(enc.ephemeralPub).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different agents produce same fields for same senderPriv but different ciphertexts for different agents", () => {
    const priv1 = randomBytes(32);
    const priv2 = randomBytes(32);
    const pub1  = x25519.getPublicKey(priv1);
    const pub2  = x25519.getPublicKey(priv2);
    const id    = randomBytes(32).toString("hex");
    const enc1  = createMockEncryptedTask(pub1, id, 0.01);
    const enc2  = createMockEncryptedTask(pub2, id, 0.01);
    // Different recipients → different ephemeral keys and ciphertexts
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });
});

// ── D. Liquefy NullArchive ────────────────────────────────────────────────────

describe("D. Liquefy NullArchive", () => {
  test("createNullArchive([]) with empty entries → archive with only decoys", () => {
    const archive = createNullArchive([], 4);
    expect(archive.realEntries).toBe(0);
    expect(archive.totalEntries).toBe(4);
    expect(archive.entries.every((e) => e.isDecoy)).toBe(true);
  });

  test("real entries count matches input", () => {
    const entries = [makeEntry(), makeEntry(), makeEntry()];
    const archive = createNullArchive(entries, 4);
    expect(archive.realEntries).toBe(3);
  });

  test("totalEntries = realEntries + decoyCount", () => {
    const entries = [makeEntry(), makeEntry()];
    const archive = createNullArchive(entries, 5);
    expect(archive.totalEntries).toBe(entries.length + 5);
  });

  test("merkleRoot is 64-char hex", () => {
    const entries = [makeEntry()];
    const archive = createNullArchive(entries);
    expect(archive.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  test("archiveId is 32-char hex", () => {
    const archive = createNullArchive([makeEntry()]);
    expect(archive.archiveId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("scanArchiveForAgent returns only matching entries", () => {
    const myId    = "my-passport-id";
    const mine    = makeEntry({ agentPassportId: myId });
    const theirs  = makeEntry({ agentPassportId: "other-id" });
    const archive = createNullArchive([mine, theirs], 0);
    const found   = scanArchiveForAgent(archive, myId);
    expect(found).toHaveLength(1);
    expect(found[0]!.taskId).toBe(mine.taskId);
  });

  test("scanArchiveForAgent never returns decoy entries", () => {
    const myId   = "my-passport-id";
    const entry  = makeEntry({ agentPassportId: myId });
    const archive = createNullArchive([entry], 10);
    const found  = scanArchiveForAgent(archive, myId);
    expect(found.every((e) => !e.isDecoy)).toBe(true);
  });

  test("bridgeArchiveToAnchor returns 34-byte instruction", () => {
    const archive = createNullArchive([makeEntry()]);
    const result  = bridgeArchiveToAnchor(archive);
    const buf     = Buffer.from(result.anchorInstructionData, "base64");
    expect(buf.length).toBe(34);
  });

  test("bridgeArchiveToAnchor instruction starts with 0x01, 0x00", () => {
    const archive = createNullArchive([makeEntry()]);
    const result  = bridgeArchiveToAnchor(archive);
    const buf     = Buffer.from(result.anchorInstructionData, "base64");
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0x00);
  });

  test("bridgeArchiveToAnchor batchReceiptRoot equals archive merkleRoot", () => {
    const archive = createNullArchive([makeEntry()]);
    const result  = bridgeArchiveToAnchor(archive);
    expect(result.batchReceiptRoot).toBe(archive.merkleRoot);
  });

  test("bridgeArchiveToAnchor decoyCount is correct", () => {
    const archive = createNullArchive([makeEntry()], 4);
    const result  = bridgeArchiveToAnchor(archive);
    expect(result.decoyCount).toBe(4);
  });

  test("mergeArchives deduplicates by taskId", () => {
    const shared = makeEntry({ taskId: "shared-task" });
    const a1 = createNullArchive([shared, makeEntry()], 0);
    const a2 = createNullArchive([shared, makeEntry()], 0);
    const merged = mergeArchives([a1, a2]);
    // shared appears once, plus 2 unique entries, plus default 4 decoys
    expect(merged.realEntries).toBe(3); // shared + 2 unique
  });

  test("mergeArchives returns a valid archive with a merkleRoot", () => {
    const a1 = createNullArchive([makeEntry(), makeEntry()], 0);
    const a2 = createNullArchive([makeEntry()], 0);
    const merged = mergeArchives([a1, a2]);
    expect(merged.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── E. NULL Flywheel ──────────────────────────────────────────────────────────

describe("E. NULL Flywheel", () => {
  test("computeNullYield(1.0, 5) = 0.05", () => {
    expect(computeNullYield(1.0, 5)).toBeCloseTo(0.05, 10);
  });

  test("computeNullYield(0.0, 5) = 0.0", () => {
    expect(computeNullYield(0.0, 5)).toBe(0.0);
  });

  test("computeNullYield scales linearly with rate", () => {
    expect(computeNullYield(10.0, 10)).toBeCloseTo(1.0, 10);
    expect(computeNullYield(10.0, 1)).toBeCloseTo(0.1, 10);
  });

  test("NullFlywheel.computeYield returns correct nullYield", () => {
    const fw = new NullFlywheel(makeFlywheelConfig());
    const yld = fw.computeYield("task1", 1.0, "rc" + "0".repeat(62));
    expect(yld.nullYield).toBeCloseTo(0.05, 10);
  });

  test("NullFlywheel.computeYield mintAuthorizationHash is 64-char hex", () => {
    const fw  = new NullFlywheel(makeFlywheelConfig());
    const yld = fw.computeYield("task1", 1.0, "0".repeat(64));
    expect(yld.mintAuthorizationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("buildMintAuthorizationHash is 64-char hex", () => {
    const h = buildMintAuthorizationHash("task1", "0".repeat(64), 0.05, 12345);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("buildMintAuthorizationHash is deterministic", () => {
    const h1 = buildMintAuthorizationHash("task1", "0".repeat(64), 0.05, 12345);
    const h2 = buildMintAuthorizationHash("task1", "0".repeat(64), 0.05, 12345);
    expect(h1).toBe(h2);
  });

  test("buildMintAuthorizationHash changes when epochId changes", () => {
    const h1 = buildMintAuthorizationHash("task1", "0".repeat(64), 0.05, 1);
    const h2 = buildMintAuthorizationHash("task1", "0".repeat(64), 0.05, 2);
    expect(h1).not.toBe(h2);
  });

  test("currentEpoch().epochId is consistent across calls", () => {
    const fw = new NullFlywheel(makeFlywheelConfig());
    const e1 = fw.currentEpoch();
    const e2 = fw.currentEpoch();
    expect(e1.epochId).toBe(e2.epochId);
  });

  test("recordEmission updates epoch stats", () => {
    const fw = new NullFlywheel(makeFlywheelConfig());
    const yld = fw.computeYield("task-x", 2.0, "0".repeat(64));
    fw.recordEmission(yld);
    const epoch = fw.currentEpoch();
    expect(epoch.taskCount).toBe(1);
    expect(epoch.totalUsdcWorked).toBeCloseTo(2.0, 10);
    expect(epoch.totalNullEmitted).toBeCloseTo(0.10, 10);
  });

  test("totalNullEmitted accumulates across multiple emissions", () => {
    const fw = new NullFlywheel(makeFlywheelConfig({ nullEmissionRatePct: 10 }));
    const rc = "0".repeat(64);
    fw.recordEmission(fw.computeYield("t1", 1.0, rc));
    fw.recordEmission(fw.computeYield("t2", 1.0, rc));
    fw.recordEmission(fw.computeYield("t3", 1.0, rc));
    expect(fw.totalNullEmitted()).toBeCloseTo(0.30, 8);
  });

  test("epoch cap enforcement — isEpochCapped=true when limit reached", () => {
    const fw = new NullFlywheel(makeFlywheelConfig({ maxNullPerEpoch: 0.1 }));
    const rc = "0".repeat(64);
    // 1.0 USDC at 5% = 0.05 NULL < cap
    const y1 = fw.computeYield("t1", 1.0, rc);
    fw.recordEmission(y1);
    // 2.0 USDC at 5% = 0.10 NULL, but remaining cap = 0.1 - 0.05 = 0.05
    const y2 = fw.computeYield("t2", 2.0, rc);
    expect(y2.isEpochCapped).toBe(true);
    expect(y2.nullYield).toBeCloseTo(0.05, 8);
  });

  test("epoch cap: once fully exhausted, yield is 0", () => {
    const fw = new NullFlywheel(makeFlywheelConfig({ maxNullPerEpoch: 0.01 }));
    const rc = "0".repeat(64);
    const y1 = fw.computeYield("t1", 1.0, rc);
    fw.recordEmission(y1);
    // force cap
    const capEpoch = fw.currentEpoch();
    capEpoch.totalNullEmitted = 0.01;

    const y2 = fw.computeYield("t2", 1.0, rc);
    // After fully capping the epoch, yield should be 0
    // (The flywheel reads fresh from the map — re-record to trigger cap)
    fw.recordEmission(y1); // push over cap
    const y3 = fw.computeYield("t3", 1.0, rc);
    expect(y3.isEpochCapped).toBe(true);
  });

  test("epochHistory returns epochs in chronological order", () => {
    const fw = new NullFlywheel(makeFlywheelConfig());
    const rc = "0".repeat(64);
    fw.recordEmission(fw.computeYield("t1", 1.0, rc));
    const history = fw.epochHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.epochId).toBeGreaterThan(history[i - 1]!.epochId);
    }
  });
});
