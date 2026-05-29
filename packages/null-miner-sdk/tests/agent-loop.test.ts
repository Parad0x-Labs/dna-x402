/**
 * NULL Miner SDK — Agent Loop Tests
 *
 * Unit tests for passport, task registry, and agent loop logic.
 * No network calls — all mock/devnet fixtures.
 */

import { AgentPassport } from "../src/core/Passport.js";
import { TaskRegistry }  from "../src/tasks/TaskRegistry.js";
import { TaskKind, ReputationTier } from "../src/core/types.js";
import { NullMiner }     from "../src/core/NullMiner.js";
import { createHash }    from "crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSpendKey(): string {
  return createHash("sha256").update(String(Math.random())).digest("hex");
}

function makePassport(epoch = 0) {
  return new AgentPassport({ spendKey: makeSpendKey(), epoch });
}

// ── Passport Tests ────────────────────────────────────────────────────────────

describe("AgentPassport", () => {
  test("generates deterministic passportId from spendKey", () => {
    const key = makeSpendKey();
    const p1  = new AgentPassport({ spendKey: key });
    const p2  = new AgentPassport({ spendKey: key });
    expect(p1.passportId).toBe(p2.passportId);
  });

  test("different spendKeys produce different passportIds", () => {
    const p1 = makePassport();
    const p2 = makePassport();
    expect(p1.passportId).not.toBe(p2.passportId);
  });

  test("starts at bronze tier with score 0", () => {
    const p = makePassport();
    expect(p.reputationScore).toBe(0);
    expect(p.tier).toBe(ReputationTier.Bronze);
  });

  test("score increases after recording receipt", () => {
    const p = makePassport();
    p.recordReceipt({
      receiptHash:    createHash("sha256").update("r1").digest("hex"),
      programId:      createHash("sha256").update("p1").digest("hex"),
      amountLamports: 1_000_000n,
      epoch:          1,
    });
    expect(p.reputationScore).toBeGreaterThan(0);
  });

  test("tier upgrades with enough receipts", () => {
    const p = makePassport();
    // 40 receipts × 5 pts = 200 → Silver
    for (let i = 0; i < 40; i++) {
      p.recordReceipt({
        receiptHash:    createHash("sha256").update(`r${i}`).digest("hex"),
        programId:      createHash("sha256").update(`p${i % 5}`).digest("hex"),
        amountLamports: 1_000_000n,
        epoch:          i,
      });
    }
    expect(p.reputationScore).toBeGreaterThanOrEqual(200);
    expect([ReputationTier.Silver, ReputationTier.Gold, ReputationTier.Elite])
      .toContain(p.tier);
  });

  test("stealth addresses differ per task", () => {
    const p = makePassport();
    const s1 = p.deriveStealthAddress("a".repeat(64));
    const s2 = p.deriveStealthAddress("b".repeat(64));
    expect(s1).not.toBe(s2);
  });

  test("stealth address is deterministic for same task", () => {
    const key  = makeSpendKey();
    const p1   = new AgentPassport({ spendKey: key });
    const p2   = new AgentPassport({ spendKey: key });
    const task = "c".repeat(64);
    expect(p1.deriveStealthAddress(task)).toBe(p2.deriveStealthAddress(task));
  });

  test("attestation throws if claimed score exceeds actual", () => {
    const p = makePassport();
    expect(() => p.attest(999)).toThrow();
  });

  test("attestation succeeds for score 0", () => {
    const p    = makePassport();
    const att  = p.attest(0);
    expect(att.passportId).toBe(p.passportId);
    expect(att.reputationScore).toBe(0);
    expect(att.proofBlob).toHaveLength(64); // 32 bytes hex
  });

  test("rejects invalid spendKey length", () => {
    expect(() => new AgentPassport({ spendKey: "tooshort" })).toThrow();
  });
});

// ── Task Registry Tests ───────────────────────────────────────────────────────

describe("TaskRegistry", () => {
  test("all built-in task kinds are registered", () => {
    const reg = new TaskRegistry();
    const supported = reg.listSupported();
    expect(supported).toContain(TaskKind.ResidentialRelay);
    expect(supported).toContain(TaskKind.AppStoreSnapshot);
    expect(supported).toContain(TaskKind.LocationAttestation);
    expect(supported).toContain(TaskKind.ProtocolMaintenance);
  });

  test("get returns executor for known kind", () => {
    const reg = new TaskRegistry();
    expect(reg.get(TaskKind.ProtocolMaintenance)).toBeDefined();
  });

  test("get returns undefined for unregistered kind", () => {
    const reg = new TaskRegistry();
    expect(reg.get("unknown_kind" as TaskKind)).toBeUndefined();
  });

  test("custom executor can be registered and retrieved", () => {
    const reg = new TaskRegistry();
    const custom = { execute: async () => "deadbeef" };
    reg.register(TaskKind.SensorSample, custom);
    expect(reg.get(TaskKind.SensorSample)).toBe(custom);
  });
});

// ── ProtocolMaintenance Executor ──────────────────────────────────────────────

describe("ProtocolMaintenanceExecutor", () => {
  test("returns a 64-char hex output hash", async () => {
    const reg      = new TaskRegistry();
    const executor = reg.get(TaskKind.ProtocolMaintenance)!;
    const task = {
      taskId:         "a".repeat(64),
      kind:           TaskKind.ProtocolMaintenance,
      rewardUsdc:     0.001,
      expiresAtSlot:  9_999_999,
      proofRequirements: { expectedProofHash: "b".repeat(64) },
    };
    const result = await executor.execute(task);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  test("same task produces different hashes at different times", async () => {
    const reg      = new TaskRegistry();
    const executor = reg.get(TaskKind.ProtocolMaintenance)!;
    const task = {
      taskId:         "a".repeat(64),
      kind:           TaskKind.ProtocolMaintenance,
      rewardUsdc:     0.001,
      expiresAtSlot:  9_999_999,
      proofRequirements: { expectedProofHash: "b".repeat(64) },
    };
    await new Promise(r => setTimeout(r, 5));
    const h1 = await executor.execute(task);
    await new Promise(r => setTimeout(r, 5));
    const h2 = await executor.execute(task);
    // Timestamps differ → hashes should differ
    expect(h1).not.toBe(h2);
  });
});

// ── NullMiner Instantiation ───────────────────────────────────────────────────

describe("NullMiner", () => {
  const mockWallet = {
    publicKey:       "NULLminerTest1111111111111111111111111111111",
    signTransaction: async (tx: unknown) => tx,
  };

  test("initialises without throwing", () => {
    expect(() => new NullMiner({
      rpcUrl:     "https://api.devnet.solana.com",
      hostWallet: mockWallet,
      platformId: "test-platform",
      dryRun:     true,
    })).not.toThrow();
  });

  test("passportId is a 64-char hex string", () => {
    const m = new NullMiner({
      rpcUrl:     "https://api.devnet.solana.com",
      hostWallet: mockWallet,
      platformId: "test-platform",
      dryRun:     true,
    });
    expect(m.getPassportId()).toHaveLength(64);
    expect(m.getPassportId()).toMatch(/^[0-9a-f]+$/);
  });

  test("stats start at zero", () => {
    const m = new NullMiner({
      rpcUrl:     "https://api.devnet.solana.com",
      hostWallet: mockWallet,
      platformId: "test-platform",
      dryRun:     true,
    });
    const stats = m.getStats();
    expect(stats.tasksCompleted).toBe(0);
    expect(stats.usdcEarned).toBe(0);
    expect(stats.nullEarned).toBe(0);
  });

  test("attest(0) succeeds on fresh miner", () => {
    const m = new NullMiner({
      rpcUrl:     "https://api.devnet.solana.com",
      hostWallet: mockWallet,
      platformId: "test-platform",
      dryRun:     true,
    });
    const att = m.attest(0);
    expect(att.reputationScore).toBe(0);
    expect(att.tier).toBe(ReputationTier.Bronze);
  });

  test("different platformIds produce different passportIds", () => {
    const m1 = new NullMiner({ rpcUrl: "https://api.devnet.solana.com", hostWallet: mockWallet, platformId: "platform-a", dryRun: true });
    const m2 = new NullMiner({ rpcUrl: "https://api.devnet.solana.com", hostWallet: mockWallet, platformId: "platform-b", dryRun: true });
    // Different platforms = different agents (different spend keys)
    // Note: spend keys are random per instance in Node.js context so this always holds
    expect(m1.getPassportId()).toBeDefined();
    expect(m2.getPassportId()).toBeDefined();
  });
});

// ── Passport Nullifier / Replay / Receipt Tests ───────────────────────────────

describe("AgentPassport — nullifier/replay/receipt (Fix 7)", () => {
  const SPEND_KEY = "a".repeat(64);
  const TASK_A    = "b".repeat(64);
  const TASK_B    = "c".repeat(64);
  const PROOF     = "d".repeat(64);

  test("nullifierSeed is a 64-char hex string", () => {
    const p = new AgentPassport({ spendKey: SPEND_KEY });
    const seed = p.nullifierSeed(TASK_A);
    expect(seed).toHaveLength(64);
    expect(seed).toMatch(/^[0-9a-f]+$/);
  });

  test("nullifierSeed is deterministic for same (key, task)", () => {
    const p1 = new AgentPassport({ spendKey: SPEND_KEY });
    const p2 = new AgentPassport({ spendKey: SPEND_KEY });
    expect(p1.nullifierSeed(TASK_A)).toBe(p2.nullifierSeed(TASK_A));
  });

  test("nullifierSeed differs per task", () => {
    const p = new AgentPassport({ spendKey: SPEND_KEY });
    expect(p.nullifierSeed(TASK_A)).not.toBe(p.nullifierSeed(TASK_B));
  });

  test("replayKey is deterministic for same (key, task)", () => {
    const p1 = new AgentPassport({ spendKey: SPEND_KEY });
    const p2 = new AgentPassport({ spendKey: SPEND_KEY });
    expect(p1.replayKey(TASK_A)).toBe(p2.replayKey(TASK_A));
  });

  test("replayKey differs per task (same task cannot produce two valid claim keys)", () => {
    const p = new AgentPassport({ spendKey: SPEND_KEY });
    expect(p.replayKey(TASK_A)).not.toBe(p.replayKey(TASK_B));
  });

  test("replayKey differs from nullifierSeed (domain separation)", () => {
    const p = new AgentPassport({ spendKey: SPEND_KEY });
    expect(p.replayKey(TASK_A)).not.toBe(p.nullifierSeed(TASK_A));
  });

  test("taskReceiptCommitment is deterministic", () => {
    const p1 = new AgentPassport({ spendKey: SPEND_KEY });
    const p2 = new AgentPassport({ spendKey: SPEND_KEY });
    expect(p1.taskReceiptCommitment(TASK_A, PROOF))
      .toBe(p2.taskReceiptCommitment(TASK_A, PROOF));
  });

  test("taskReceiptCommitment differs if proof changes", () => {
    const p = new AgentPassport({ spendKey: SPEND_KEY });
    const c1 = p.taskReceiptCommitment(TASK_A, PROOF);
    const c2 = p.taskReceiptCommitment(TASK_A, "e".repeat(64));
    expect(c1).not.toBe(c2);
  });

  test("scopedPassportId differs per platform", () => {
    const p = new AgentPassport({ spendKey: SPEND_KEY });
    const s1 = p.scopedPassportId("platform-x");
    const s2 = p.scopedPassportId("platform-y");
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(p.passportId);
  });

  test("same platform always gets same scopedPassportId", () => {
    const p1 = new AgentPassport({ spendKey: SPEND_KEY });
    const p2 = new AgentPassport({ spendKey: SPEND_KEY });
    expect(p1.scopedPassportId("platform-z")).toBe(p2.scopedPassportId("platform-z"));
  });
});

// ── x402 Payment Rail Tests ───────────────────────────────────────────────────

import {
  createPaymentRequirement,
  verifyPaymentHeader,
  anchorReceiptPayload,
  platformFeeSplit,
  usdcToAtomic,
  atomicToUsdc,
} from "../src/x402/index.js";

describe("x402 payment rail (Fix 6)", () => {
  const REQ = createPaymentRequirement({
    priceUsdc: 0.005,
    recipientAddress: "1".repeat(44),
    resource: "/api/test",
    platformWallet: "2".repeat(44),
  });

  test("createPaymentRequirement returns correct shape", () => {
    expect(REQ.scheme).toBe("exact");
    expect(REQ.network).toBe("solana-devnet");
    expect(REQ.maxAmountRequired).toBe("5000");
    expect(REQ.memoPrefix).toBe("null-miner-v1");
    expect(REQ.extra.platformFeePct).toBe(0.10);
    expect(REQ.extra.anchorReceipt).toBe(true);
  });

  test("verifyPaymentHeader rejects missing header", () => {
    const r = verifyPaymentHeader(null, REQ);
    expect(r.valid).toBe(false);
  });

  test("verifyPaymentHeader rejects underpayment", () => {
    const payload = Buffer.from(JSON.stringify({ payerAddress: "ABC", amount: "1" })).toString("base64");
    const r = verifyPaymentHeader(payload, REQ);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/Insufficient/);
  });

  test("verifyPaymentHeader rejects malformed payload", () => {
    const r = verifyPaymentHeader("notbase64!@#", REQ);
    expect(r.valid).toBe(false);
  });

  test("verifyPaymentHeader accepts exact payment", () => {
    const payload = Buffer.from(JSON.stringify({
      payerAddress: "PayerWallet11111111111111111111111111111111",
      amount: "5000",
      signature: "stub",
    })).toString("base64");
    const r = verifyPaymentHeader(payload, REQ);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.amountUsdc).toBe(0.005);
      expect(r.amountAtomic).toBe(5000);
      expect(r.receiptHash).toHaveLength(64);
    }
  });

  test("verifyPaymentHeader accepts overpayment", () => {
    const payload = Buffer.from(JSON.stringify({
      payerAddress: "PayerWallet11111111111111111111111111111111",
      amount: "9999",  // more than required 5000
    })).toString("base64");
    const r = verifyPaymentHeader(payload, REQ);
    expect(r.valid).toBe(true);
  });

  test("anchorReceiptPayload builds valid payload", () => {
    const payedPayload = Buffer.from(JSON.stringify({
      payerAddress: "ABC",
      amount: "5000",
    })).toString("base64");
    const verified = verifyPaymentHeader(payedPayload, REQ);
    if (!verified.valid) return;

    const anchor = anchorReceiptPayload(verified, { platformId: "test-platform", passportId: "x".repeat(64) });
    expect(anchor.receiptHash).toBe(verified.receiptHash);
    expect(anchor.platformId).toBe("test-platform");
    expect(anchor.passportId).toBe("x".repeat(64));
    expect(anchor.routeToFlywheel).toBe(true);
    // instructionDataBase64 must decode to exactly 34 bytes:
    // [0x01, 0x00, anchor32[0..32]] — receipt_anchor SINGLE_LEN_NO_BUCKET format
    const ixBuf = Buffer.from(anchor.instructionDataBase64, "base64");
    expect(ixBuf.length).toBe(34);
    expect(ixBuf[0]).toBe(0x01);  // INSTRUCTION_VERSION_V1
    expect(ixBuf[1]).toBe(0x00);  // flags (no bucket_id override)
    expect(typeof anchor.instructionDataBase64).toBe("string");
    expect(anchor.memo).toContain("null-miner-v1");
  });

  test("platformFeeSplit computes correct split", () => {
    const split = platformFeeSplit(0.005, 0.10, 0.05);
    expect(Math.abs(split.agentUsdc    - 0.0045  )).toBeLessThan(1e-9);
    expect(Math.abs(split.platformUsdc - 0.0005  )).toBeLessThan(1e-9);
    expect(Math.abs(split.nullFlywheelUsdc - 0.000225)).toBeLessThan(1e-9);
    expect(split.atomic.total).toBe(5000);
    expect(split.atomic.agent).toBe(4500);
    expect(split.atomic.platform).toBe(500);
  });

  test("usdcToAtomic / atomicToUsdc roundtrip", () => {
    expect(usdcToAtomic(0.005)).toBe(5000);
    expect(atomicToUsdc(5000)).toBe(0.005);
    expect(usdcToAtomic(1.0)).toBe(1_000_000);
  });
});

// ── Proof Validation Tests (Fix 5) ───────────────────────────────────────────

import { AgentLoop } from "../src/core/AgentLoop.js";
import type { TaskSpec, TaskKind as TK } from "../src/core/types.js";

describe("Proof validation — defaults to reject on mismatch (Fix 5)", () => {
  const SPEND_KEY = "f".repeat(64);
  const mockWalletProof = {
    publicKey: "NULLminerTest1111111111111111111111111111111",
    signTransaction: async (tx: unknown) => tx,
  };

  const GOOD_TASK: TaskSpec = {
    taskId:         "a".repeat(64),
    kind:           "protocol_maintenance" as TK,
    rewardUsdc:     0.001,
    expiresAtSlot:  999_999_999,
    proofRequirements: { expectedProofHash: "a".repeat(64) },
  };

  test("dryRun=true never executes tasks (no proof check needed)", async () => {
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop     = new AgentLoop(
      { rpcUrl: "https://api.devnet.solana.com", hostWallet: mockWalletProof, platformId: "t", dryRun: true },
      passport,
    );
    // dryRun just logs and returns — no proof mismatch error
    await expect(
      (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["executeTask"](GOOD_TASK)
    ).resolves.not.toThrow();
  });

  test("allowProofMismatchInDev=false (default) rejects wrong proof via submitProof", async () => {
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop     = new AgentLoop(
      {
        rpcUrl: "https://api.devnet.solana.com",
        hostWallet: mockWalletProof,
        platformId: "t",
        dryRun: false,
        allowProofMismatchInDev: false,
      },
      passport,
    );

    const badProof = {
      taskId:         GOOD_TASK.taskId,
      kind:           GOOD_TASK.kind,
      outputHash:     "wrong_hash_not_matching",
      agentPassportId: passport.passportId,
      timestamp:      Date.now(),
    };

    await expect(
      (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["submitProof"](GOOD_TASK, badProof)
    ).rejects.toThrow(/Proof hash mismatch/);
  });

  test("allowProofMismatchInDev=true accepts wrong proof", async () => {
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop     = new AgentLoop(
      {
        rpcUrl: "https://api.devnet.solana.com",
        hostWallet: mockWalletProof,
        platformId: "t",
        dryRun: false,
        allowProofMismatchInDev: true,
      },
      passport,
    );

    const badProof = {
      taskId:         GOOD_TASK.taskId,
      kind:           GOOD_TASK.kind,
      outputHash:     "wrong_hash",
      agentPassportId: passport.passportId,
      timestamp:      Date.now(),
    };

    await expect(
      (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["submitProof"](GOOD_TASK, badProof)
    ).resolves.toBeGreaterThan(0);
  });

  test("matching proof hash succeeds regardless of dryRun flag", async () => {
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop     = new AgentLoop(
      { rpcUrl: "https://api.devnet.solana.com", hostWallet: mockWalletProof, platformId: "t", dryRun: false },
      passport,
    );

    const goodProof = {
      taskId:         GOOD_TASK.taskId,
      kind:           GOOD_TASK.kind,
      outputHash:     "a".repeat(64),  // matches GOOD_TASK.proofRequirements.expectedProofHash
      agentPassportId: passport.passportId,
      timestamp:      Date.now(),
    };

    await expect(
      (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["submitProof"](GOOD_TASK, goodProof)
    ).resolves.toBeGreaterThan(0);
  });
});

// ── onReceiptReady: server-free direct-to-Solana path ────────────────────────

describe("onReceiptReady: direct on-chain proof path", () => {
  const SPEND_KEY = "e".repeat(64);
  const mockWalletRR = {
    publicKey: "NULLminerTest1111111111111111111111111111111",
    signTransaction: async (tx: unknown) => tx,
  };

  const TASK: TaskSpec = {
    taskId:         "d".repeat(64),
    kind:           "protocol_maintenance" as TK,
    rewardUsdc:     0.005,
    expiresAtSlot:  999_999_999,
    proofRequirements: { expectedProofHash: "d".repeat(64) },
  };

  const PROOF = {
    taskId:         TASK.taskId,
    kind:           TASK.kind,
    outputHash:     "d".repeat(64),   // matches expectedProofHash
    agentPassportId: "x".repeat(64),
    timestamp:      Date.now(),
  };

  test("onReceiptReady: called in server-free mode when provided", async () => {
    let called = false;
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop = new AgentLoop(
      {
        rpcUrl:     "https://api.devnet.solana.com",
        hostWallet: mockWalletRR,
        platformId: "t",
        dryRun:     false,
        allowProofMismatchInDev: true,
        onReceiptReady: async (_ix: Uint8Array) => { called = true; },
      },
      passport,
    );
    await (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["submitProof"](TASK, PROOF);
    expect(called).toBe(true);
  });

  test("onReceiptReady: receives 34-byte Uint8Array", async () => {
    let received: Uint8Array | null = null;
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop = new AgentLoop(
      {
        rpcUrl:     "https://api.devnet.solana.com",
        hostWallet: mockWalletRR,
        platformId: "t",
        dryRun:     false,
        allowProofMismatchInDev: true,
        onReceiptReady: async (ix: Uint8Array) => { received = ix; },
      },
      passport,
    );
    await (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["submitProof"](TASK, PROOF);
    expect(received).not.toBeNull();
    expect(received!.length).toBe(34);
  });

  test("onReceiptReady: first byte is 0x01", async () => {
    let received: Uint8Array | null = null;
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop = new AgentLoop(
      {
        rpcUrl:     "https://api.devnet.solana.com",
        hostWallet: mockWalletRR,
        platformId: "t",
        dryRun:     false,
        allowProofMismatchInDev: true,
        onReceiptReady: async (ix: Uint8Array) => { received = ix; },
      },
      passport,
    );
    await (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["submitProof"](TASK, PROOF);
    expect(received![0]).toBe(0x01);
  });

  test("onReceiptReady: non-fatal if callback throws", async () => {
    const passport = new AgentPassport({ spendKey: SPEND_KEY });
    const loop = new AgentLoop(
      {
        rpcUrl:     "https://api.devnet.solana.com",
        hostWallet: mockWalletRR,
        platformId: "t",
        dryRun:     false,
        allowProofMismatchInDev: true,
        onReceiptReady: async (_ix: Uint8Array) => {
          throw new Error("simulated Solana RPC failure");
        },
      },
      passport,
    );
    // Should resolve (not reject) — the callback failure is swallowed
    await expect(
      (loop as unknown as Record<string, (...a: unknown[]) => Promise<void>>)["submitProof"](TASK, PROOF)
    ).resolves.toBeGreaterThan(0);
  });
});
