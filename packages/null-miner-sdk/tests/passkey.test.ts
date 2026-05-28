/**
 * null-miner-sdk — Dark Agent Vault: Passkey (secp256r1 / WebAuthn) Tests
 *
 * Validates all security properties of the passkey vault path:
 *   - Challenge creation and determinism
 *   - Assertion helper structure and key material extraction
 *   - Roundtrip encrypt/decrypt
 *   - Wrong assertion/params all fail
 *   - Cross-compatibility: passkey version !== Phantom version
 *   - Passkey-specific binding (credentialId, rpId)
 *   - Chunk splitting with passkey-encrypted blobs
 */

import {
  createPasskeyChallenge,
  extractAssertionKeyMaterial,
  encryptAgentKeyWithPasskey,
  decryptAgentKeyWithPasskey,
  createTestPasskeyAssertion,
  PASSKEY_VAULT_VERSION,
  uint8ToHex,
  generateVaultSalt,
  splitVaultBlob,
  assembleVaultBlob,
} from "../src/vault/index.js";
import type { PasskeyVaultParams } from "../src/vault/index.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const AGENT_KEY = new Uint8Array(32).fill(0xab);

const BASE_PASSKEY_PARAMS: PasskeyVaultParams = {
  walletPubkey: "wallet1111111111111111111111111111111111111111111",
  agentPubkey:  "agent2222222222222222222222222222222222222222222",
  vaultId:      "passkey-vault-001",
  appDomain:    "app.parad0x.io",
  passkeyCredentialId: "Y3JlZGVudGlhbElkMTIz", // base64url
  rpId:         "app.parad0x.io",
};

const SEED_A = new Uint8Array(32).fill(0x01);
const SEED_B = new Uint8Array(32).fill(0x02);

async function makePasskeyVault(
  params: PasskeyVaultParams = BASE_PASSKEY_PARAMS,
  seed: Uint8Array = SEED_A,
) {
  const assertion = createTestPasskeyAssertion(params, seed);
  const salt      = generateVaultSalt();
  const vault     = await encryptAgentKeyWithPasskey(AGENT_KEY, assertion, salt, params);
  return { vault, assertion, salt };
}

// ── A. Challenge creation ─────────────────────────────────────────────────────

describe("Passkey challenge creation", () => {
  test("createPasskeyChallenge returns a PasskeyChallenge object", async () => {
    const ch = await createPasskeyChallenge(BASE_PASSKEY_PARAMS);
    expect(ch).toBeDefined();
    expect(typeof ch.challenge).toBe("string");
    expect(typeof ch.rpId).toBe("string");
    expect(typeof ch.message).toBe("string");
    expect(ch.params).toEqual(BASE_PASSKEY_PARAMS);
  });

  test("challenge is a non-empty base64url string", async () => {
    const ch = await createPasskeyChallenge(BASE_PASSKEY_PARAMS);
    expect(ch.challenge.length).toBeGreaterThan(0);
    // base64url uses - and _ not + and /; no padding =
    expect(ch.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("challenge is deterministic — same params → same challenge", async () => {
    const ch1 = await createPasskeyChallenge(BASE_PASSKEY_PARAMS);
    const ch2 = await createPasskeyChallenge(BASE_PASSKEY_PARAMS);
    expect(ch1.challenge).toBe(ch2.challenge);
  });

  test("challenge differs for different rpId", async () => {
    const ch1 = await createPasskeyChallenge(BASE_PASSKEY_PARAMS);
    const ch2 = await createPasskeyChallenge({ ...BASE_PASSKEY_PARAMS, rpId: "other.example.com" });
    expect(ch1.challenge).not.toBe(ch2.challenge);
  });

  test("message contains agentPubkey prefix (first 8 chars)", async () => {
    const ch = await createPasskeyChallenge(BASE_PASSKEY_PARAMS);
    expect(ch.message).toContain(BASE_PASSKEY_PARAMS.agentPubkey.slice(0, 8));
  });

  test("rpId in returned struct matches params.rpId", async () => {
    const ch = await createPasskeyChallenge(BASE_PASSKEY_PARAMS);
    expect(ch.rpId).toBe(BASE_PASSKEY_PARAMS.rpId);
  });
});

// ── B. Assertion helpers ──────────────────────────────────────────────────────

describe("Passkey assertion helpers", () => {
  test("createTestPasskeyAssertion returns all required fields", () => {
    const a = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    expect(typeof a.credentialId).toBe("string");
    expect(typeof a.authenticatorData).toBe("string");
    expect(typeof a.clientDataJSON).toBe("string");
    expect(typeof a.signature).toBe("string");
    // userHandle is optional; credentialId must be present
    expect(a.credentialId.length).toBeGreaterThan(0);
  });

  test("authenticatorData is base64url decodeable and >= 37 bytes", () => {
    const a = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const bytes = Buffer.from(a.authenticatorData.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(bytes.length).toBeGreaterThanOrEqual(37);
  });

  test("clientDataJSON is base64url decodeable", () => {
    const a = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const bytes = Buffer.from(a.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("clientDataJSON parses as valid JSON containing webauthn.get", () => {
    const a = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const json = Buffer.from(
      a.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("webauthn.get");
    expect(typeof parsed.challenge).toBe("string");
    expect(typeof parsed.origin).toBe("string");
  });

  test("extractAssertionKeyMaterial returns Uint8Array", () => {
    const a = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const km = extractAssertionKeyMaterial(a);
    expect(km).toBeInstanceOf(Uint8Array);
  });

  test("keyMaterial.length > 32 (37 authData bytes + 32 clientDataHash = 69)", () => {
    const a = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const km = extractAssertionKeyMaterial(a);
    expect(km.length).toBeGreaterThan(32);
  });

  test("keyMaterial is deterministic for same assertion", () => {
    const a = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const km1 = extractAssertionKeyMaterial(a);
    const km2 = extractAssertionKeyMaterial(a);
    expect(uint8ToHex(km1)).toBe(uint8ToHex(km2));
  });

  test("keyMaterial differs for different seeds", () => {
    const a1 = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const a2 = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_B);
    const km1 = extractAssertionKeyMaterial(a1);
    const km2 = extractAssertionKeyMaterial(a2);
    expect(uint8ToHex(km1)).not.toBe(uint8ToHex(km2));
  });
});

// ── C. Encrypt / decrypt roundtrip ────────────────────────────────────────────

describe("Passkey encrypt / decrypt roundtrip", () => {
  test("encrypt then decrypt returns original agent key", async () => {
    const { vault, assertion } = await makePasskeyVault();
    const recovered = await decryptAgentKeyWithPasskey(vault, assertion, BASE_PASSKEY_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });

  test("wrong seed → decrypt throws", async () => {
    const { vault } = await makePasskeyVault(BASE_PASSKEY_PARAMS, SEED_A);
    const wrongAssertion = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_B);
    await expect(
      decryptAgentKeyWithPasskey(vault, wrongAssertion, BASE_PASSKEY_PARAMS),
    ).rejects.toThrow(/fail|tamper|mismatch/i);
  });

  test("wrong vaultId in params → decrypt throws", async () => {
    const { vault, assertion } = await makePasskeyVault();
    const wrongParams = { ...BASE_PASSKEY_PARAMS, vaultId: "different-vault-999" };
    await expect(
      decryptAgentKeyWithPasskey(vault, assertion, wrongParams),
    ).rejects.toThrow(/mismatch|tamper|fail/i);
  });

  test("wrong walletPubkey in params → decrypt throws", async () => {
    const { vault, assertion } = await makePasskeyVault();
    const wrongParams = { ...BASE_PASSKEY_PARAMS, walletPubkey: "walletXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" };
    await expect(
      decryptAgentKeyWithPasskey(vault, assertion, wrongParams),
    ).rejects.toThrow(/mismatch|tamper|fail/i);
  });

  test("version in encrypted blob equals PASSKEY_VAULT_VERSION", async () => {
    const { vault } = await makePasskeyVault();
    expect(vault.version).toBe(PASSKEY_VAULT_VERSION);
    expect(vault.version).toBe("dark-passkey-vault-v1");
  });
});

// ── D. Cross-compatibility ────────────────────────────────────────────────────

describe("Cross-compatibility: passkey vs Phantom vault versions are distinct", () => {
  test("passkey vault version !== Phantom vault version", async () => {
    const { vault } = await makePasskeyVault();
    // Phantom vault version is "dark-agent-vault-v1"
    expect(vault.version).not.toBe("dark-agent-vault-v1");
    expect(vault.version).toBe(PASSKEY_VAULT_VERSION);
  });

  test("PASSKEY_VAULT_VERSION constant has the expected string value", () => {
    expect(PASSKEY_VAULT_VERSION).toBe("dark-passkey-vault-v1");
  });
});

// ── E. Passkey-specific binding ───────────────────────────────────────────────

describe("Passkey-specific binding", () => {
  test("different passkeyCredentialId → different key → decrypt fails", async () => {
    const params1 = { ...BASE_PASSKEY_PARAMS, passkeyCredentialId: "Y3JlZGVudGlhbElkMTIz" };
    const params2 = { ...BASE_PASSKEY_PARAMS, passkeyCredentialId: "ZGlmZmVyZW50Q3JlZA" };

    const assertion1 = createTestPasskeyAssertion(params1, SEED_A);
    const salt = generateVaultSalt();
    const vault1 = await encryptAgentKeyWithPasskey(AGENT_KEY, assertion1, salt, params1);

    // Decrypt with params2 (different credentialId) should fail on AAD hash check
    await expect(
      decryptAgentKeyWithPasskey(
        { ...vault1, appDomain: params2.appDomain },
        assertion1,
        params2,
      ),
    ).rejects.toThrow(/mismatch|tamper|fail/i);
  });

  test("different rpId → different encryption key → decrypt fails", async () => {
    const params1 = { ...BASE_PASSKEY_PARAMS, rpId: "app.parad0x.io" };
    const params2 = { ...BASE_PASSKEY_PARAMS, rpId: "evil.example.com" };

    const assertion1 = createTestPasskeyAssertion(params1, SEED_A);
    const salt = generateVaultSalt();
    const vault1 = await encryptAgentKeyWithPasskey(AGENT_KEY, assertion1, salt, params1);

    // Use a correctly-formed vault but wrong rpId in params — AAD will differ
    await expect(
      decryptAgentKeyWithPasskey(vault1, assertion1, params2),
    ).rejects.toThrow(/mismatch|tamper|fail/i);
  });

  test("different salt → different ciphertext, but each salt correctly decrypts its own vault", async () => {
    const assertion = createTestPasskeyAssertion(BASE_PASSKEY_PARAMS, SEED_A);
    const salt1 = new Uint8Array(32).fill(0x11);
    const salt2 = new Uint8Array(32).fill(0x22);

    const vault1 = await encryptAgentKeyWithPasskey(AGENT_KEY, assertion, salt1, BASE_PASSKEY_PARAMS);
    const vault2 = await encryptAgentKeyWithPasskey(AGENT_KEY, assertion, salt2, BASE_PASSKEY_PARAMS);

    // Ciphertexts must differ (different key from different salt)
    expect(uint8ToHex(vault1.ciphertext)).not.toBe(uint8ToHex(vault2.ciphertext));

    // Each vault decrypts correctly with the matching params
    const recovered1 = await decryptAgentKeyWithPasskey(vault1, assertion, BASE_PASSKEY_PARAMS);
    const recovered2 = await decryptAgentKeyWithPasskey(vault2, assertion, BASE_PASSKEY_PARAMS);
    expect(recovered1).toEqual(AGENT_KEY);
    expect(recovered2).toEqual(AGENT_KEY);
  });
});

// ── F. Chunk splitting with passkey vault ─────────────────────────────────────

describe("Chunk splitting with passkey-encrypted vault", () => {
  test("splitVaultBlob works with passkey-encrypted blob", async () => {
    const { vault } = await makePasskeyVault();
    const result = splitVaultBlob(vault);
    expect(result.realChunks.length).toBeGreaterThan(0);
    expect(result.decoyChunks.length).toBeGreaterThan(0);
    expect(result.allChunks.length).toBe(result.realChunks.length + result.decoyChunks.length);
    expect(result.manifest.version).toBe(PASSKEY_VAULT_VERSION);
  });

  test("assembleVaultBlob recovers original ciphertext", async () => {
    const { vault, assertion } = await makePasskeyVault();
    const { allChunks, manifest } = splitVaultBlob(vault);
    const reassembled = assembleVaultBlob(allChunks, manifest);

    // The reassembled blob should decrypt correctly
    const recovered = await decryptAgentKeyWithPasskey(reassembled, assertion, BASE_PASSKEY_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });

  test("assembleVaultBlob with extra decoys still recovers correct agent key", async () => {
    const { vault, assertion } = await makePasskeyVault();
    const { allChunks, decoyChunks, manifest } = splitVaultBlob(vault);

    // Add extra random decoys
    const extraDecoy = { ...decoyChunks[0]!, chunkId: "extra-decoy-id-999" };
    const withExtra = [...allChunks, extraDecoy];

    const reassembled = assembleVaultBlob(withExtra, manifest);
    const recovered = await decryptAgentKeyWithPasskey(reassembled, assertion, BASE_PASSKEY_PARAMS);
    expect(recovered).toEqual(AGENT_KEY);
  });

  test("manifest.version equals PASSKEY_VAULT_VERSION", async () => {
    const { vault } = await makePasskeyVault();
    const { manifest } = splitVaultBlob(vault);
    expect(manifest.version).toBe(PASSKEY_VAULT_VERSION);
  });
});
