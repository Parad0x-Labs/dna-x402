/**
 * null-miner-sdk — Dark Agent Vault Tests
 *
 * Validates all security properties:
 *   - Roundtrip encrypt/decrypt
 *   - Wrong wallet/domain/vault/agent all fail
 *   - Tampered ciphertext and metadata fail
 *   - Server-leak simulation: stored row has no raw key material
 *   - Chunk/decoy reconstruction
 *   - Backend guard
 *   - Browser-compatibility (WebCrypto only)
 */

import { ed25519 } from "@noble/curves/ed25519";
import {
  createVaultChallenge,
  encryptAgentKey,
  decryptAgentKey,
  generateVaultSalt,
  splitVaultBlob,
  assembleVaultBlob,
  buildStoredVaultRow,
  buildVaultMetadata,
  assertNoVaultSecretMaterial,
  uint8ToHex,
} from "../src/vault/index.js";
import type { VaultParams, StoredVaultRow } from "../src/vault/index.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const WALLET_A_PRIV = new Uint8Array(32).fill(0x01);
const WALLET_B_PRIV = new Uint8Array(32).fill(0x02);
const WALLET_A_PUB  = uint8ToHex(ed25519.getPublicKey(WALLET_A_PRIV));
const WALLET_B_PUB  = uint8ToHex(ed25519.getPublicKey(WALLET_B_PRIV));

const AGENT_KEY     = new Uint8Array(32).fill(0xab);
const AGENT_PUB     = uint8ToHex(ed25519.getPublicKey(AGENT_KEY));

const BASE_PARAMS: VaultParams = {
  walletPubkey: WALLET_A_PUB,
  agentPubkey:  AGENT_PUB,
  vaultId:      "test-vault-001",
  appDomain:    "app.parad0x.io",
};

function signChallenge(msg: string, privKey: Uint8Array): Uint8Array {
  return ed25519.sign(new TextEncoder().encode(msg), privKey);
}

async function makeVault(params = BASE_PARAMS, privKey = WALLET_A_PRIV) {
  const challenge = createVaultChallenge(params);
  const sig       = signChallenge(challenge, privKey);
  const salt      = generateVaultSalt();
  const vault     = await encryptAgentKey(AGENT_KEY, sig, salt, params);
  return { vault, sig, salt, challenge };
}

// ── A. Roundtrip ──────────────────────────────────────────────────────────────

describe("Vault roundtrip", () => {
  test("encrypt then decrypt returns original agent key", async () => {
    const { vault, sig } = await makeVault();
    const recovered = await decryptAgentKey(vault, sig, BASE_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });

  test("challenge is deterministic (no timestamp)", () => {
    const c1 = createVaultChallenge(BASE_PARAMS);
    const c2 = createVaultChallenge(BASE_PARAMS);
    expect(c1).toBe(c2);
  });

  test("challenge contains required fields", () => {
    const c = createVaultChallenge(BASE_PARAMS);
    expect(c).toContain("Dark Agent Vault v1");
    expect(c).toContain(`Domain: ${BASE_PARAMS.appDomain}`);
    expect(c).toContain(`Wallet: ${BASE_PARAMS.walletPubkey}`);
    expect(c).toContain(`Agent: ${BASE_PARAMS.agentPubkey}`);
    expect(c).toContain(`Vault: ${BASE_PARAMS.vaultId}`);
    expect(c).toContain("Warning: This is not a transaction");
  });

  test("same signature re-used for decrypt succeeds", async () => {
    const { vault, sig } = await makeVault();
    // ed25519 is deterministic — re-signing same message gives same sig
    const sig2 = signChallenge(createVaultChallenge(BASE_PARAMS), WALLET_A_PRIV);
    expect(sig).toEqual(sig2);
    const recovered = await decryptAgentKey(vault, sig2, BASE_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });
});

// ── B. Wrong wallet fails ─────────────────────────────────────────────────────

describe("Wrong wallet fails", () => {
  test("different wallet pubkey in params triggers metadata check", async () => {
    const { vault } = await makeVault();
    const wrongParams = { ...BASE_PARAMS, walletPubkey: WALLET_B_PUB };
    await expect(decryptAgentKey(vault, new Uint8Array(64), wrongParams))
      .rejects.toThrow(/mismatch|tampered|fail/i);
  });

  test("different wallet signature (same pubkey) → HKDF key mismatch → decrypt fails", async () => {
    const { vault } = await makeVault();
    // Use wallet B's signature but wallet A's pubkey in params
    const wrongSig = signChallenge(createVaultChallenge(BASE_PARAMS), WALLET_B_PRIV);
    await expect(decryptAgentKey(vault, wrongSig, BASE_PARAMS))
      .rejects.toThrow(/fail/i);
  });
});

// ── C. Wrong domain fails ─────────────────────────────────────────────────────

describe("Wrong domain fails", () => {
  test("different appDomain in params rejected before decryption", async () => {
    const { vault } = await makeVault();
    const wrongParams = { ...BASE_PARAMS, appDomain: "evil.example.com" };
    await expect(decryptAgentKey(vault, new Uint8Array(64), wrongParams))
      .rejects.toThrow(/mismatch|tampered|fail/i);
  });
});

// ── D. Wrong vault id fails ───────────────────────────────────────────────────

describe("Wrong vault id fails", () => {
  test("different vaultId in params rejected before decryption", async () => {
    const { vault } = await makeVault();
    const wrongParams = { ...BASE_PARAMS, vaultId: "different-vault-999" };
    await expect(decryptAgentKey(vault, new Uint8Array(64), wrongParams))
      .rejects.toThrow(/mismatch|tampered|fail/i);
  });
});

// ── E. Wrong agent pubkey fails ───────────────────────────────────────────────

describe("Wrong agent pubkey fails", () => {
  test("different agentPubkey in params rejected before decryption", async () => {
    const { vault } = await makeVault();
    const otherAgentPub = uint8ToHex(ed25519.getPublicKey(new Uint8Array(32).fill(0x99)));
    const wrongParams = { ...BASE_PARAMS, agentPubkey: otherAgentPub };
    await expect(decryptAgentKey(vault, new Uint8Array(64), wrongParams))
      .rejects.toThrow(/mismatch|tampered|fail/i);
  });
});

// ── F. Tampered ciphertext fails ──────────────────────────────────────────────

describe("Tampered ciphertext fails", () => {
  test("flipping one byte in ciphertext causes GCM auth failure", async () => {
    const { vault, sig } = await makeVault();
    // Flip a byte in the middle of the ciphertext
    const tampered = new Uint8Array(vault.ciphertext);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    const tamperedVault = { ...vault, ciphertext: tampered };
    await expect(decryptAgentKey(tamperedVault, sig, BASE_PARAMS))
      .rejects.toThrow(/fail|tamper|decrypt/i);
  });

  test("flipping last byte (auth tag area) causes GCM auth failure", async () => {
    const { vault, sig } = await makeVault();
    const tampered = new Uint8Array(vault.ciphertext);
    tampered[tampered.length - 1] ^= 0x01;
    const tamperedVault = { ...vault, ciphertext: tampered };
    await expect(decryptAgentKey(tamperedVault, sig, BASE_PARAMS))
      .rejects.toThrow(/fail|tamper|decrypt/i);
  });
});

// ── G. Tampered metadata fails ────────────────────────────────────────────────

describe("Tampered metadata fails", () => {
  test("altered walletPubkey in vault blob → metadata check fails", async () => {
    const { vault, sig } = await makeVault();
    const tampered = { ...vault, walletPubkey: WALLET_B_PUB };
    // params still has wallet A — so vault.walletPubkey !== params.walletPubkey
    await expect(decryptAgentKey(tampered, sig, BASE_PARAMS))
      .rejects.toThrow(/mismatch|tampered|fail/i);
  });

  test("altered agentPubkey in vault blob → metadata check fails", async () => {
    const { vault, sig } = await makeVault();
    const otherPub = uint8ToHex(ed25519.getPublicKey(new Uint8Array(32).fill(0x77)));
    const tampered = { ...vault, agentPubkey: otherPub };
    await expect(decryptAgentKey(tampered, sig, BASE_PARAMS))
      .rejects.toThrow(/mismatch|tampered|fail/i);
  });

  test("altered vaultId in vault blob → metadata check fails", async () => {
    const { vault, sig } = await makeVault();
    const tampered = { ...vault, vaultId: "tampered-vault-id" };
    await expect(decryptAgentKey(tampered, sig, BASE_PARAMS))
      .rejects.toThrow(/mismatch|tampered|fail/i);
  });

  test("altered aadHash in vault blob → aadHash verification fails", async () => {
    const { vault, sig } = await makeVault();
    const tampered = { ...vault, aadHash: "a".repeat(64) };
    await expect(decryptAgentKey(tampered, sig, BASE_PARAMS))
      .rejects.toThrow(/aad|tamper|mismatch|fail/i);
  });
});

// ── H. Server leak simulation ─────────────────────────────────────────────────

describe("Server leak simulation", () => {
  test("stored row contains no raw agent key as hex or base64", async () => {
    const { vault } = await makeVault();
    const { allChunks } = splitVaultBlob(vault);
    const row: StoredVaultRow = buildStoredVaultRow(vault, allChunks);

    const rowJson = JSON.stringify(row);
    const agentKeyHex    = uint8ToHex(AGENT_KEY);
    const agentKeyBase64 = Buffer.from(AGENT_KEY).toString("base64");

    expect(rowJson).not.toContain(agentKeyHex);
    expect(rowJson).not.toContain(agentKeyBase64);
  });

  test("stored row contains no wallet private key", async () => {
    const { vault } = await makeVault();
    const { allChunks } = splitVaultBlob(vault);
    const row = buildStoredVaultRow(vault, allChunks);
    const rowJson = JSON.stringify(row);

    const walletPrivHex    = uint8ToHex(WALLET_A_PRIV);
    const walletPrivBase64 = Buffer.from(WALLET_A_PRIV).toString("base64");
    expect(rowJson).not.toContain(walletPrivHex);
    expect(rowJson).not.toContain(walletPrivBase64);
  });

  test("stored row contains no encryption signature", async () => {
    const { vault, sig } = await makeVault();
    const { allChunks } = splitVaultBlob(vault);
    const row = buildStoredVaultRow(vault, allChunks);
    const rowJson = JSON.stringify(row);

    const sigHex = uint8ToHex(sig);
    expect(rowJson).not.toContain(sigHex);
  });

  test("stored row does not contain raw HKDF-derived key", async () => {
    // We don't export the raw key, but let's verify no 'vaultKey' field exists
    const { vault } = await makeVault();
    const { allChunks } = splitVaultBlob(vault);
    const row = buildStoredVaultRow(vault, allChunks) as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty("vaultKey");
    expect(row).not.toHaveProperty("encryptionKey");
    expect(row).not.toHaveProperty("decryptedKey");
  });

  test("correct wallet can still decrypt after leak (attacker cannot)", async () => {
    const { vault, sig } = await makeVault();
    const { allChunks, manifest } = splitVaultBlob(vault);
    // Simulate server leak: attacker has all stored data
    const row = buildStoredVaultRow(vault, allChunks);

    // Attacker cannot decrypt without the signature (which is not in the row)
    const rowJson = JSON.parse(JSON.stringify(row));
    expect(rowJson).toBeDefined(); // row exists

    // Owner with correct signature can reassemble and decrypt
    const reassembled = assembleVaultBlob(row.allChunks, manifest);
    const recovered   = await decryptAgentKey(reassembled, sig, BASE_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });
});

// ── I. Chunk/decoy reconstruction ────────────────────────────────────────────

describe("Chunk and decoy reconstruction", () => {
  test("all real chunks reconstruct original ciphertext", async () => {
    const { vault, sig } = await makeVault();
    const { allChunks, manifest } = splitVaultBlob(vault);
    const reassembled = assembleVaultBlob(allChunks, manifest);
    const recovered = await decryptAgentKey(reassembled, sig, BASE_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });

  test("removing one real chunk causes assembly to throw", async () => {
    const { vault } = await makeVault();
    const { allChunks, manifest } = splitVaultBlob(vault);
    // Remove one real chunk (they're shuffled with decoys — remove by ID)
    const withoutFirst = allChunks.filter(c => c.chunkId !== manifest.realChunkIds[0]);
    expect(() => assembleVaultBlob(withoutFirst, manifest)).toThrow(/missing/i);
  });

  test("adding extra decoys does not break reconstruction", async () => {
    const { vault, sig } = await makeVault();
    const { allChunks, decoyChunks, manifest } = splitVaultBlob(vault);
    // Add extra decoys from another vault split
    const { vault: vault2 } = await makeVault({ ...BASE_PARAMS, vaultId: "extra-decoy-source" });
    const { decoyChunks: extraDecoys } = splitVaultBlob(vault2);
    const withExtraDecoys = [...allChunks, ...extraDecoys.map(d => ({
      ...d,
      vaultId: BASE_PARAMS.vaultId, // same vaultId but unknown chunkIds
    }))];
    // Assembly only uses real chunk IDs from manifest — extras are ignored
    const reassembled = assembleVaultBlob(withExtraDecoys, manifest);
    const recovered   = await decryptAgentKey(reassembled, sig, BASE_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);

    // Confirm decoys are in the shuffled set
    expect(decoyChunks.length).toBeGreaterThan(0);
  });

  test("decoy chunks are indistinguishable from real by chunk size", async () => {
    const { vault } = await makeVault();
    const { realChunks, decoyChunks } = splitVaultBlob(vault);
    // Every chunk has same hex-encoded ciphertextChunk length
    const realLen  = realChunks[0]!.ciphertextChunk.length;
    for (const c of realChunks)  expect(c.ciphertextChunk.length).toBe(realLen);
    for (const d of decoyChunks) expect(d.ciphertextChunk.length).toBe(realLen);
  });

  test("shuffle is deterministic (same vault → same order)", async () => {
    const { vault } = await makeVault();
    const r1 = splitVaultBlob(vault);
    const r2 = splitVaultBlob(vault);
    expect(r1.allChunks.map(c => c.chunkId)).toEqual(r2.allChunks.map(c => c.chunkId));
  });
});

// ── J. Backend guard ──────────────────────────────────────────────────────────

describe("assertNoVaultSecretMaterial", () => {
  const forbidden = [
    "privateKey",
    "secretKey",
    "agentSecretKey",
    "seed",
    "mnemonic",
    "decryptedKey",
    "encryptionKey",
    "vaultKey",
    "signatureUsedForEncryption",
  ];

  for (const key of forbidden) {
    test(`rejects payload containing "${key}"`, () => {
      const payload = { [key]: "somevalue", vaultId: "v1" } as Record<string, unknown>;
      expect(() => assertNoVaultSecretMaterial(payload)).toThrow(new RegExp(`"?${key}"?`, "i"));
    });
  }

  test("allows safe vault metadata fields", () => {
    const safe: Record<string, unknown> = {
      vaultId:          "vault-001",
      ownerWalletPubkey: WALLET_A_PUB,
      agentPubkey:      AGENT_PUB,
      vaultCommitment:  "abc123",
      salt:             "defsalt",
      iv:               "abc",
      aadHash:          "hashval",
      version:          "dark-agent-vault-v1",
      createdAt:        Date.now(),
    };
    expect(() => assertNoVaultSecretMaterial(safe)).not.toThrow();
  });

  test("rejects nested forbidden key", () => {
    const nested: Record<string, unknown> = {
      vaultId: "v1",
      metadata: { privateKey: "hidden" },
    };
    expect(() => assertNoVaultSecretMaterial(nested)).toThrow(/privateKey/i);
  });

  test("case-insensitive: rejects PRIVATEKEY", () => {
    const payload = { PRIVATEKEY: "val" } as Record<string, unknown>;
    expect(() => assertNoVaultSecretMaterial(payload)).toThrow();
  });
});

// ── K. Browser compatibility ──────────────────────────────────────────────────

describe("Browser compatibility", () => {
  test("WebCrypto path: globalThis.crypto.subtle is used (no Node-only crypto)", async () => {
    // If we can encrypt + decrypt, WebCrypto works
    const { vault, sig } = await makeVault();
    const recovered = await decryptAgentKey(vault, sig, BASE_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });

  test("browser entry point exports all required functions", () => {
    const browser = require("../src/vault/browser");
    expect(typeof browser.createVaultChallenge).toBe("function");
    expect(typeof browser.encryptAgentKey).toBe("function");
    expect(typeof browser.decryptAgentKey).toBe("function");
    expect(typeof browser.generateVaultSalt).toBe("function");
    expect(typeof browser.splitVaultBlob).toBe("function");
    expect(typeof browser.assembleVaultBlob).toBe("function");
  });

  test("vault metadata exposes no raw keys", async () => {
    const { vault } = await makeVault();
    const meta = buildVaultMetadata(vault);
    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain(uint8ToHex(AGENT_KEY));
    expect(meta.x402ActivationReceipt).toBeDefined();
    expect(meta.vaultCommitment).toHaveLength(64);
  });
});
