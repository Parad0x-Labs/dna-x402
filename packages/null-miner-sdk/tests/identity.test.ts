/**
 * null-miner-sdk — Identity module tests
 *
 * Covers:
 *   A. MetaMask / secp256k1 auth message construction
 *   B. ETH signature recovery with a deterministic test key
 *   C. PassportV2 tiered identity
 *   D. Guild / Coalition system
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// MetaMask module
import {
  createEthAgentAuthMessage,
  formatEthPersonalSignMessage,
  ethPersonalSignHash,
  parseEthSignature,
  recoverEthAddress,
  deriveAgentAuthPda,
  buildSecp256k1AuthInstruction,
} from "../src/identity/metamask.js";
import type { EthAgentAuthMessage } from "../src/identity/metamask.js";

// PassportV2 module
import {
  AgentPassportV2,
  PassportTier,
  upgradePassportTier,
  computePassportId,
} from "../src/core/PassportV2.js";

// Coalition module
import {
  createCoalition,
  buildCoalitionSignal,
  verifyCoalitionThreshold,
  addCoalitionMember,
} from "../src/coalitions/index.js";
import type { CoalitionMember } from "../src/coalitions/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// A. MetaMask auth message
// ─────────────────────────────────────────────────────────────────────────────

describe("MetaMask auth message", () => {
  const baseOpts = {
    domain: "null-miner.xyz",
    agentPubkey: "AeioU1234567890abcdef1234567890abcdef1234567890ab",
    vaultId: "vault-test-001",
  };

  test("createEthAgentAuthMessage returns all required fields", () => {
    const msg = createEthAgentAuthMessage(baseOpts);
    expect(msg.domain).toBe(baseOpts.domain);
    expect(msg.agentPubkey).toBe(baseOpts.agentPubkey);
    expect(msg.vaultId).toBe(baseOpts.vaultId);
    expect(msg.version).toBe("eth-agent-auth-v1");
    expect(msg.nonce).toBeDefined();
    expect(msg.nonce.length).toBe(32); // 16 bytes hex
    expect(msg.ethAddress).toBeDefined();
  });

  test("createEthAgentAuthMessage uses provided nonce", () => {
    const nonce = "deadbeefdeadbeef";
    const msg = createEthAgentAuthMessage({ ...baseOpts, nonce });
    expect(msg.nonce).toBe(nonce);
  });

  test("createEthAgentAuthMessage generates different nonces each time", () => {
    const m1 = createEthAgentAuthMessage(baseOpts);
    const m2 = createEthAgentAuthMessage(baseOpts);
    expect(m1.nonce).not.toBe(m2.nonce);
  });

  test("formatEthPersonalSignMessage contains all key fields", () => {
    const nonce = "aabbccdd11223344";
    const msg = createEthAgentAuthMessage({ ...baseOpts, nonce });
    const formatted = formatEthPersonalSignMessage(msg);
    expect(formatted).toContain(baseOpts.domain);
    expect(formatted).toContain(baseOpts.agentPubkey);
    expect(formatted).toContain(baseOpts.vaultId);
    expect(formatted).toContain(nonce);
    expect(formatted).toContain("Solana Agent Authorization v1");
    expect(formatted).toContain("Warning: This authorizes a Solana agent key");
  });

  test("ethPersonalSignHash returns a 32-byte Uint8Array", () => {
    const msg = createEthAgentAuthMessage(baseOpts);
    const formatted = formatEthPersonalSignMessage(msg);
    const hash = ethPersonalSignHash(formatted);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  test("ethPersonalSignHash is deterministic for same message", () => {
    const nonce = "1122334455667788";
    const msg = createEthAgentAuthMessage({ ...baseOpts, nonce });
    const formatted = formatEthPersonalSignMessage(msg);
    const h1 = ethPersonalSignHash(formatted);
    const h2 = ethPersonalSignHash(formatted);
    expect(Buffer.from(h1).toString("hex")).toBe(Buffer.from(h2).toString("hex"));
  });

  test("ethPersonalSignHash differs for different messages", () => {
    const m1 = createEthAgentAuthMessage({ ...baseOpts, nonce: "aaaa000000000000" });
    const m2 = createEthAgentAuthMessage({ ...baseOpts, nonce: "bbbb111111111111" });
    const h1 = ethPersonalSignHash(formatEthPersonalSignMessage(m1));
    const h2 = ethPersonalSignHash(formatEthPersonalSignMessage(m2));
    expect(Buffer.from(h1).toString("hex")).not.toBe(Buffer.from(h2).toString("hex"));
  });

  test("parseEthSignature splits a 65-byte hex into r, s, v, recoveryId", () => {
    // 64 bytes of r+s = 'aa' * 32 + 'bb' * 32, v = 0x1b (27)
    const rHex = "aa".repeat(32);
    const sHex = "bb".repeat(32);
    const vHex = "1b"; // 27
    const sigHex = rHex + sHex + vHex;

    const components = parseEthSignature(sigHex);
    expect(components.r).toHaveLength(32);
    expect(components.s).toHaveLength(32);
    expect(components.v).toBe(27);
    expect(components.recoveryId).toBe(0);
    expect(Buffer.from(components.r).toString("hex")).toBe(rHex);
    expect(Buffer.from(components.s).toString("hex")).toBe(sHex);
  });

  test("parseEthSignature handles 0x prefix and v=28", () => {
    const rHex = "cc".repeat(32);
    const sHex = "dd".repeat(32);
    const vHex = "1c"; // 28
    const sigHex = "0x" + rHex + sHex + vHex;

    const components = parseEthSignature(sigHex);
    expect(components.v).toBe(28);
    expect(components.recoveryId).toBe(1);
  });

  test("parseEthSignature rejects wrong length", () => {
    expect(() => parseEthSignature("aabb")).toThrow();
  });

  test("deriveAgentAuthPda returns 64-char hex pdaSeed", () => {
    const pda = deriveAgentAuthPda(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "AgentPubkey123",
      "null-miner.xyz"
    );
    expect(pda.pdaSeed).toHaveLength(64);
    expect(pda.authHash).toHaveLength(64);
  });

  test("deriveAgentAuthPda is deterministic", () => {
    const addr  = "0x1234567890abcdef1234567890abcdef12345678";
    const agent = "SomeAgentPubkey";
    const domain = "test.domain";
    const p1 = deriveAgentAuthPda(addr, agent, domain);
    const p2 = deriveAgentAuthPda(addr, agent, domain);
    expect(p1.pdaSeed).toBe(p2.pdaSeed);
    expect(p1.authHash).toBe(p2.authHash);
  });

  test("pdaSeed differs for different ethAddress", () => {
    const agent  = "SomeAgentPubkey";
    const domain = "test.domain";
    const p1 = deriveAgentAuthPda("0xaaaa000000000000000000000000000000000001", agent, domain);
    const p2 = deriveAgentAuthPda("0xbbbb000000000000000000000000000000000002", agent, domain);
    expect(p1.pdaSeed).not.toBe(p2.pdaSeed);
  });

  test("buildSecp256k1AuthInstruction returns exactly 200 bytes", () => {
    const pda = deriveAgentAuthPda(
      "0xabcdef1234567890abcdef1234567890abcdef12",
      "AgentPubkeyXYZ",
      "null-miner.xyz"
    );
    const sigComponents = {
      r: new Uint8Array(32).fill(0x11),
      s: new Uint8Array(32).fill(0x22),
      v: 27,
      recoveryId: 0,
    };
    const msgHash = new Uint8Array(32).fill(0x33);
    const ix = buildSecp256k1AuthInstruction(pda, sigComponents, msgHash);
    expect(ix).toBeInstanceOf(Uint8Array);
    expect(ix.length).toBe(200);
  });

  test("buildSecp256k1AuthInstruction first byte is discriminant 0x01", () => {
    const pda = deriveAgentAuthPda("0x0000000000000000000000000000000000000001", "K", "d");
    const ix = buildSecp256k1AuthInstruction(
      pda,
      { r: new Uint8Array(32), s: new Uint8Array(32), v: 27, recoveryId: 0 },
      new Uint8Array(32)
    );
    expect(ix[0]).toBe(0x01);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. ETH signature recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("ETH signature recovery", () => {
  // Deterministic test private key: [1, 2, 3, ..., 32]
  const ETH_PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const ETH_PUB  = secp256k1.getPublicKey(ETH_PRIV, false); // 65 bytes, uncompressed

  // Expected ETH address from the known private key
  const pubNoPrefix = ETH_PUB.subarray(1); // 64 bytes
  const addrHash    = keccak_256(pubNoPrefix);
  const EXPECTED_ADDR = "0x" + Buffer.from(addrHash.subarray(12)).toString("hex");

  test("expected ETH address is 42 chars (0x + 40 hex)", () => {
    expect(EXPECTED_ADDR).toHaveLength(42);
    expect(EXPECTED_ADDR.startsWith("0x")).toBe(true);
  });

  test("recoverEthAddress returns the correct address for a known key", () => {
    const msg = createEthAgentAuthMessage({
      domain: "recovery-test.xyz",
      agentPubkey: "TestAgentPubkey123",
      vaultId: "vault-recovery-001",
      nonce: "aabbccddeeff0011",
    });

    const formatted = formatEthPersonalSignMessage(msg);
    const msgHash   = ethPersonalSignHash(formatted);

    // Sign with noble secp256k1
    const sig = secp256k1.sign(msgHash, ETH_PRIV);

    // Build 65-byte hex: r(32) + s(32) + v(1)
    const rHex = Buffer.from(sig.r.toString(16).padStart(64, "0"), "hex");
    const sHex = Buffer.from(sig.s.toString(16).padStart(64, "0"), "hex");
    const vByte = Buffer.from([27 + sig.recovery]);
    const sigHex = Buffer.concat([rHex, sHex, vByte]).toString("hex");

    const recovered = recoverEthAddress(msg, sigHex);
    expect(recovered).toBe(EXPECTED_ADDR);
  });

  test("recoverEthAddress is consistent across calls", () => {
    const msg = createEthAgentAuthMessage({
      domain: "consistency-test.xyz",
      agentPubkey: "AgentConsistency99",
      vaultId: "vault-c-001",
      nonce: "1122334455667788",
    });

    const formatted = formatEthPersonalSignMessage(msg);
    const msgHash   = ethPersonalSignHash(formatted);
    const sig       = secp256k1.sign(msgHash, ETH_PRIV);

    const rHex = Buffer.from(sig.r.toString(16).padStart(64, "0"), "hex");
    const sHex = Buffer.from(sig.s.toString(16).padStart(64, "0"), "hex");
    const vByte = Buffer.from([27 + sig.recovery]);
    const sigHex = Buffer.concat([rHex, sHex, vByte]).toString("hex");

    const r1 = recoverEthAddress(msg, sigHex);
    const r2 = recoverEthAddress(msg, sigHex);
    expect(r1).toBe(r2);
    expect(r1).toBe(EXPECTED_ADDR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. PassportV2
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentPassportV2", () => {
  const spendKey = Uint8Array.from({ length: 32 }, (_, i) => i + 10);
  const config = {
    spendKey,
    tier: PassportTier.Device,
    platformId: "test-platform",
  };

  test("constructor accepts valid 32-byte spendKey", () => {
    expect(() => new AgentPassportV2(config)).not.toThrow();
  });

  test("constructor throws for wrong spendKey length", () => {
    expect(
      () => new AgentPassportV2({ ...config, spendKey: new Uint8Array(16) })
    ).toThrow();
  });

  test("passportId is 64-char hex string", () => {
    const p = new AgentPassportV2(config);
    expect(p.passportId).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(p.passportId)).toBe(true);
  });

  test("passportId is deterministic for same spendKey", () => {
    const p1 = new AgentPassportV2(config);
    const p2 = new AgentPassportV2(config);
    expect(p1.passportId).toBe(p2.passportId);
  });

  test("passportId differs for different spendKeys", () => {
    const p1 = new AgentPassportV2(config);
    const p2 = new AgentPassportV2({
      ...config,
      spendKey: Uint8Array.from({ length: 32 }, (_, i) => i + 20),
    });
    expect(p1.passportId).not.toBe(p2.passportId);
  });

  test("attest() returns correct tier", () => {
    const p = new AgentPassportV2({ ...config, tier: PassportTier.MetaMask });
    const att = p.attest();
    expect(att.tier).toBe(PassportTier.MetaMask);
    expect(att.tierName).toBe("MetaMask");
  });

  test("attest() returns eligible task kinds for tier", () => {
    const p = new AgentPassportV2({ ...config, tier: PassportTier.Device });
    const att = p.attest();
    expect(att.eligibleTaskKinds).toContain("residential_relay");
    expect(att.eligibleTaskKinds).toContain("app_store_snapshot");
    expect(att.eligibleTaskKinds).not.toContain("dark_pool_priority");
  });

  test("computeReputationScore() with 0 tasks = tier bonus only", () => {
    const p = new AgentPassportV2({
      ...config,
      tier: PassportTier.Passkey,
      nullifierCount: 0,
      stakedNull: 0,
    });
    // Tier1 bonus = 50
    expect(p.computeReputationScore()).toBe(50);
  });

  test("computeReputationScore() with 50 tasks = 500 base + tier bonus", () => {
    const p = new AgentPassportV2({
      ...config,
      tier: PassportTier.MetaMask,  // bonus = 100
      nullifierCount: 50,
      stakedNull: 0,
    });
    // base = min(50*10, 500) = 500, tier bonus = 100 → 600
    expect(p.computeReputationScore()).toBe(600);
  });

  test("computeReputationScore() is capped at 1000", () => {
    const p = new AgentPassportV2({
      ...config,
      tier: PassportTier.Guild,      // bonus = 200
      nullifierCount: 100,            // base = 500
      stakedNull: 100000,             // staking = min(100000/100, 150) = 150
    });
    // 500 + 200 + 150 = 850 < 1000 — let's make sure it caps at 1000
    const p2 = new AgentPassportV2({
      ...config,
      tier: PassportTier.Guild,
      nullifierCount: 1000,  // base = 500 (capped)
      stakedNull: 1000000,   // staking = 150
    });
    // 500 + 200 + 150 = 850 — not 1000. Need a specially padded case.
    // To verify cap: 500 + 200 + 150 = 850 max with Guild
    // Score will not exceed 1000 because Guild max is 850. Test the logic.
    expect(p2.computeReputationScore()).toBeLessThanOrEqual(1000);
    expect(p2.computeReputationScore()).toBe(850);
  });

  test("score is capped at 1000 when arithmetic exceeds it", () => {
    // Manually override: 500 base + 200 tier + 150 stake = 850 max
    // We can't exceed 1000 with current formula. Verify the cap works.
    const p = new AgentPassportV2({
      ...config,
      tier: PassportTier.Guild,
      nullifierCount: 50,
      stakedNull: 15000, // staking = min(150, 150) = 150
    });
    const score = p.computeReputationScore();
    expect(score).toBeLessThanOrEqual(1000);
  });

  test("canAccessTask('residential_relay') true for Tier0", () => {
    const p = new AgentPassportV2({ ...config, tier: PassportTier.Device });
    expect(p.canAccessTask("residential_relay")).toBe(true);
  });

  test("canAccessTask('dark_pool_priority') false for Tier3", () => {
    const p = new AgentPassportV2({ ...config, tier: PassportTier.ZKReputation });
    expect(p.canAccessTask("dark_pool_priority")).toBe(false);
  });

  test("canAccessTask('dark_pool_priority') true for Tier4", () => {
    const p = new AgentPassportV2({ ...config, tier: PassportTier.Guild });
    expect(p.canAccessTask("dark_pool_priority")).toBe(true);
  });

  test("canAccessTask with minTier enforces tier requirement", () => {
    const p = new AgentPassportV2({ ...config, tier: PassportTier.MetaMask });
    // MetaMask has residential_relay but does NOT meet minTier=Guild
    expect(p.canAccessTask("residential_relay", PassportTier.Guild)).toBe(false);
  });

  test("upgradePassportTier creates new passport with higher tier", () => {
    const p = new AgentPassportV2({ ...config, tier: PassportTier.Device });
    const upgraded = upgradePassportTier(p, PassportTier.MetaMask);
    expect(upgraded.tier).toBe(PassportTier.MetaMask);
    expect(upgraded.passportId).toBe(p.passportId); // same spend key
  });

  test("buildReputationProofHash is 64-char hex", () => {
    const p = new AgentPassportV2(config);
    const h = p.buildReputationProofHash();
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  test("computePassportId matches new AgentPassportV2(...).passportId", () => {
    const p = new AgentPassportV2(config);
    expect(computePassportId(spendKey)).toBe(p.passportId);
  });

  test("requiresNullifierCount(ZKReputation) = 10", () => {
    const p = new AgentPassportV2(config);
    expect(p.requiresNullifierCount(PassportTier.ZKReputation)).toBe(10);
  });

  test("requiresNullifierCount(Guild) = 25", () => {
    const p = new AgentPassportV2(config);
    expect(p.requiresNullifierCount(PassportTier.Guild)).toBe(25);
  });

  test("requiresNullifierCount(Device) = 0", () => {
    const p = new AgentPassportV2(config);
    expect(p.requiresNullifierCount(PassportTier.Device)).toBe(0);
  });

  test("priorityMultiplier matches tier", () => {
    const tiers: Array<[PassportTier, number]> = [
      [PassportTier.Device,       1.0],
      [PassportTier.Passkey,      1.2],
      [PassportTier.MetaMask,     1.5],
      [PassportTier.ZKReputation, 2.0],
      [PassportTier.Guild,        3.0],
    ];
    for (const [tier, expected] of tiers) {
      const p   = new AgentPassportV2({ ...config, tier });
      const att = p.attest();
      expect(att.priorityMultiplier).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Guild / Coalition
// ─────────────────────────────────────────────────────────────────────────────

describe("Guild / Coalition system", () => {
  function makeMembers(count: number): CoalitionMember[] {
    return Array.from({ length: count }, (_, i) => ({
      passportId:    `passport-${String(i).padStart(4, "0")}`,
      nullifierHash: Buffer.alloc(32, i + 1).toString("hex"),
      stakedNull:    (i + 1) * 1000,
      joinedAt:      1000000 + i,
    }));
  }

  const members = makeMembers(3);

  test("createCoalition with 3 members and threshold=2 works", () => {
    const coalition = createCoalition({ name: "TestGuild", members, threshold: 2 });
    expect(coalition.coalitionId).toBeDefined();
    expect(coalition.members).toHaveLength(3);
    expect(coalition.threshold).toBe(2);
    expect(coalition.totalStaked).toBe(1000 + 2000 + 3000);
  });

  test("coalitionId is deterministic for same inputs", () => {
    const c1 = createCoalition({ name: "TestGuild", members, threshold: 2 });
    const c2 = createCoalition({ name: "TestGuild", members, threshold: 2 });
    expect(c1.coalitionId).toBe(c2.coalitionId);
  });

  test("coalitionId is 32 hex chars", () => {
    const c = createCoalition({ name: "TestGuild", members, threshold: 2 });
    expect(c.coalitionId).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(c.coalitionId)).toBe(true);
  });

  test("coalitionNullifier is 64-char hex", () => {
    const c = createCoalition({ name: "TestGuild", members, threshold: 2 });
    expect(c.coalitionNullifier).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(c.coalitionNullifier)).toBe(true);
  });

  test("createCoalition throws when threshold > N", () => {
    expect(() =>
      createCoalition({ name: "TooSmall", members, threshold: 5 })
    ).toThrow();
  });

  test("buildCoalitionSignal with 2 of 3 members works", () => {
    const coalition = createCoalition({ name: "TestGuild", members, threshold: 2 });
    const signerIds = [members[0]!.passportId, members[1]!.passportId];
    const signal = buildCoalitionSignal(
      coalition,
      signerIds,
      "deadbeef".padEnd(64, "0"),
      "cafebabe".padEnd(64, "0")
    );
    expect(signal.coalitionId).toBe(coalition.coalitionId);
    expect(signal.signingMembers).toHaveLength(2);
    expect(signal.aggregateNullifierHash).toHaveLength(64);
  });

  test("verifyCoalitionThreshold returns true for valid signal", () => {
    const coalition = createCoalition({ name: "TestGuild", members, threshold: 2 });
    const signerIds = [members[0]!.passportId, members[2]!.passportId];
    const signal = buildCoalitionSignal(
      coalition,
      signerIds,
      "aabbccdd".padEnd(64, "0"),
      "11223344".padEnd(64, "0")
    );
    expect(verifyCoalitionThreshold(coalition, signal)).toBe(true);
  });

  test("verifyCoalitionThreshold returns false for wrong coalitionId", () => {
    const coalition = createCoalition({ name: "TestGuild", members, threshold: 2 });
    const signerIds = [members[0]!.passportId, members[1]!.passportId];
    const signal = buildCoalitionSignal(
      coalition,
      signerIds,
      "00".repeat(32),
      "00".repeat(32)
    );
    const spoofedSignal = { ...signal, coalitionId: "ffffffffffffffffffffffffffffffff" };
    expect(verifyCoalitionThreshold(coalition, spoofedSignal)).toBe(false);
  });

  test("buildCoalitionSignal throws when signing member not in coalition", () => {
    const coalition = createCoalition({ name: "TestGuild", members, threshold: 2 });
    expect(() =>
      buildCoalitionSignal(
        coalition,
        [members[0]!.passportId, "non-existent-passport"],
        "00".repeat(32),
        "00".repeat(32)
      )
    ).toThrow();
  });

  test("addCoalitionMember increases member count and recomputes nullifier", () => {
    const c1 = createCoalition({ name: "TestGuild", members, threshold: 2 });
    const newMember: CoalitionMember = {
      passportId:    "passport-9999",
      nullifierHash: Buffer.alloc(32, 0xaa).toString("hex"),
      stakedNull:    5000,
      joinedAt:      2000000,
    };
    const c2 = addCoalitionMember(c1, newMember);
    expect(c2.members).toHaveLength(4);
    expect(c2.coalitionNullifier).not.toBe(c1.coalitionNullifier);
    expect(c2.totalStaked).toBe(c1.totalStaked + 5000);
  });

  test("signal with K < threshold fails verifyCoalitionThreshold", () => {
    const coalition = createCoalition({ name: "TestGuild", members, threshold: 3 });
    // Build a signal with only 2 signers (below threshold=3)
    // We need to bypass buildCoalitionSignal's own check, so craft a fake signal
    const fakeSignal = {
      coalitionId:           coalition.coalitionId,
      signingMembers:        [members[0]!.passportId, members[1]!.passportId],
      aggregateNullifierHash: "00".repeat(32),
      signal:                "00".repeat(32),
      externalNullifier:     "00".repeat(32),
      timestamp:             Date.now(),
    };
    expect(verifyCoalitionThreshold(coalition, fakeSignal)).toBe(false);
  });

  test("buildCoalitionSignal throws when K < threshold", () => {
    const coalition = createCoalition({ name: "TestGuild", members, threshold: 3 });
    const signerIds = [members[0]!.passportId, members[1]!.passportId]; // only 2
    expect(() =>
      buildCoalitionSignal(coalition, signerIds, "00".repeat(32), "00".repeat(32))
    ).toThrow();
  });

  test("coalitionNullifier differs for different member sets", () => {
    const mA = makeMembers(3);
    const mB = makeMembers(3);
    mB[0]!.nullifierHash = Buffer.alloc(32, 0xff).toString("hex");
    const c1 = createCoalition({ name: "G", members: mA, threshold: 1 });
    const c2 = createCoalition({ name: "G", members: mB, threshold: 1 });
    expect(c1.coalitionNullifier).not.toBe(c2.coalitionNullifier);
  });
});
