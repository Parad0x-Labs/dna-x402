export interface ForbiddenSignerFinding {
  path: string;
  reason: string;
}

const FORBIDDEN_FIELD_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /(^|[_-])(private|priv)([_-]?key)?($|[_-])/i, reason: "private key field" },
  { regex: /(privatekey|privkey)/i, reason: "private key field" },
  { regex: /(^|[_-])session([_-]?private)?([_-]?key)($|[_-])/i, reason: "session key field" },
  { regex: /session(private)?key/i, reason: "session key field" },
  { regex: /(^|[_-])(seed|mnemonic)([_-]?phrase)?($|[_-])/i, reason: "seed phrase field" },
  { regex: /(seedphrase|mnemonicphrase)/i, reason: "seed phrase field" },
  { regex: /(^|[_-])decrypted([_-]?signer)?($|[_-])/i, reason: "decrypted signer field" },
  { regex: /decryptedsigner/i, reason: "decrypted signer field" },
  { regex: /(^|[_-])wallet([_-]?dump)?($|[_-])/i, reason: "wallet dump field" },
  { regex: /walletdump/i, reason: "wallet dump field" },
  { regex: /(^|[_-])secret([_-]?key)?($|[_-])/i, reason: "secret key field" },
  { regex: /secretkey/i, reason: "secret key field" },
  { regex: /(^|[_-])owner([_-]?key)($|[_-])/i, reason: "owner key field" },
  { regex: /ownerkey/i, reason: "owner key field" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findForbiddenSignerMaterial(input: unknown, path = "$"): ForbiddenSignerFinding[] {
  if (Array.isArray(input)) {
    return input.flatMap((value, index) => findForbiddenSignerMaterial(value, `${path}[${index}]`));
  }

  if (!isRecord(input)) {
    return [];
  }

  const findings: ForbiddenSignerFinding[] = [];
  for (const [key, value] of Object.entries(input)) {
    const nextPath = `${path}.${key}`;
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const pattern of FORBIDDEN_FIELD_PATTERNS) {
      if (pattern.regex.test(key) || pattern.regex.test(normalizedKey)) {
        findings.push({ path: nextPath, reason: pattern.reason });
      }
    }
    findings.push(...findForbiddenSignerMaterial(value, nextPath));
  }
  return findings;
}

export function assertNoBackendSignerMaterial(input: unknown): void {
  const findings = findForbiddenSignerMaterial(input);
  if (findings.length > 0) {
    const details = findings.map((finding) => `${finding.path}: ${finding.reason}`).join("; ");
    throw new Error(`Backend payload contains forbidden signer material: ${details}`);
  }
}

export function assertBackendRelayOnly(input: unknown): void {
  assertNoBackendSignerMaterial(input);
  const payload = input as { backendSigns?: unknown; serverSigns?: unknown };
  if (payload.backendSigns === true || payload.serverSigns === true) {
    throw new Error("Backend signing is forbidden for Polymarket Agent V1.");
  }
}
