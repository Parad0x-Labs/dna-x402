import { describe, expect, it } from "vitest";
import { assertBackendRelayOnly, assertNoBackendSignerMaterial } from "../src/polymarket/security.js";
import { scanTextForFindings } from "../scripts/security/scan-secrets.js";

describe("polymarket custody and security guardrails", () => {
  it("rejects private key, session key, seed phrase, decrypted signer, and wallet dump fields", () => {
    expect(() => assertNoBackendSignerMaterial({ ownerPrivateKey: "0xabc" })).toThrow(/forbidden signer material/i);
    expect(() => assertNoBackendSignerMaterial({ session_key: "0xabc" })).toThrow(/forbidden signer material/i);
    expect(() => assertNoBackendSignerMaterial({ seedPhrase: "word word word" })).toThrow(/forbidden signer material/i);
    expect(() => assertNoBackendSignerMaterial({ nested: { decryptedSigner: {} } })).toThrow(/forbidden signer material/i);
    expect(() => assertNoBackendSignerMaterial({ walletDump: [] })).toThrow(/forbidden signer material/i);
  });

  it("allows relay-safe public payloads but rejects backend signing flags", () => {
    expect(() => assertBackendRelayOnly({
      depositWallet: "0xDepositWallet",
      signedPayloadHash: "abc123",
      alreadySignedOrderPayload: "0xsigned",
    })).not.toThrow();

    expect(() => assertBackendRelayOnly({ serverSigns: true })).toThrow(/backend signing/i);
    expect(() => assertBackendRelayOnly({ backendSigns: true })).toThrow(/backend signing/i);
  });

  it("secret scan patterns catch secret-like assignments and env leaks without blocking redacted guard examples", () => {
    const privateKeyLine = ["const private", "Key = 'not_a_real_secret_but_long_enough_to_scan';"].join("");
    const seedPhraseLine = ["const seed", "Phrase = 'another_not_real_secret_long_enough_to_scan';"].join("");
    const walletDumpLine = ["const wallet", "Dump = 'not_a_real_wallet_dump_long_enough_to_scan';"].join("");
    const findings = scanTextForFindings("fixture.ts", [
      privateKeyLine,
      seedPhraseLine,
      "API_KEY=redacted",
      walletDumpLine,
    ].join("\n"));

    expect(findings.map((finding) => finding.reason)).toContain("secret-like field assignment");
    expect(findings.map((finding) => finding.reason)).toContain("env-style secret assignment");

    const redactedFindings = scanTextForFindings("fixture.ts", [
      "const privateKey = 'redacted';",
      "const seedPhrase = 'redacted words';",
      "const walletDump = 'forbidden';",
    ].join("\n"));
    expect(redactedFindings).toHaveLength(0);
  });
});
