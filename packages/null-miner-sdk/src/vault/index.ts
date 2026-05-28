/**
 * null-miner-sdk — Dark Agent Vault
 *
 * Phantom-unlocked encrypted storage for autonomous agent wallets.
 * The agent key is generated and encrypted in the browser. Parad0x stores
 * only encrypted vault chunks, decoys, commitments, and receipt metadata.
 * If the backend leaks, attackers do not get usable agent private keys.
 *
 * Backend protection guarantee: protects against *backend/database leaks*.
 * Does NOT protect against a compromised or malicious browser/app JS.
 */

export * from "./crypto.js";
export * from "./chunks.js";
export * from "./browser.js";
export type * from "./types.js";

// ── Backend guard ─────────────────────────────────────────────────────────────

/**
 * Server-side guard: throw if any request body contains known secret-material keys.
 * Call this at the start of every API handler that receives vault-related payloads.
 *
 * Protects against accidental client-side bugs that send decrypted keys to the server.
 * Case-insensitive exact key-name matching.
 */
export function assertNoVaultSecretMaterial(
  payload: Record<string, unknown>,
): void {
  const FORBIDDEN = new Set([
    "privatekey",
    "secretkey",
    "agentsecretkey",
    "seed",
    "mnemonic",
    "decryptedkey",
    "encryptionkey",
    "vaultkey",
    "signatureusedforencryption",
  ]);

  const check = (obj: Record<string, unknown>, path: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN.has(k.toLowerCase())) {
        throw new Error(
          `assertNoVaultSecretMaterial: forbidden key "${k}" at ${path} — ` +
          `vault secret material must not be sent to the server`
        );
      }
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        check(v as Record<string, unknown>, `${path}.${k}`);
      }
    }
  };

  check(payload, "$");
}
