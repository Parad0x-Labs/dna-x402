export const PII_FIELD_PATTERNS = [
  /email/i,
  /e-mail/i,
  /legalname/i,
  /legal_name/i,
  /taxid/i,
  /tax_id/i,
  /taxpayerid/i,
  /taxpayeridentification/i,
  /^tin$/i,
  /ssn/i,
  /shipping/i,
  /billing/i,
  /postaladdress/i,
  /streetaddress/i,
  /fulladdress/i,
  /ipaddress/i,
  /ip_address/i,
  /phone/i,
  /telephone/i,
  /kyc/i,
  /passport/i,
  /governmentid/i,
  /government_id/i,
  /documentimage/i,
  /document_image/i,
  /privatekey/i,
  /private_key/i,
  /seedphrase/i,
  /seed_phrase/i,
  /mnemonic/i,
] as const;

export const PII_VALUE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /data:image\/[a-z0-9.+-]+;base64,/i,
  /\b(?:[a-z]+ ){11,23}[a-z]+\b/i,
] as const;

function inspect(value: unknown, path: string, issues: string[]): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    for (const pattern of PII_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        issues.push(`${path}: raw personal or secret-like value is not allowed`);
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`, issues));
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, "");
      if (PII_FIELD_PATTERNS.some((pattern) => pattern.test(normalizedKey))) {
        issues.push(`${path}.${key}: raw PII field is not allowed in immutable records`);
      }
      inspect(nested, path ? `${path}.${key}` : key, issues);
    }
  }
}

export function findPiiIssues(value: unknown): string[] {
  const issues: string[] = [];
  inspect(value, "", issues);
  return issues;
}

export function assertNoRawPii(value: unknown): void {
  const issues = findPiiIssues(value);
  if (issues.length > 0) {
    throw new Error(`PII_FORBIDDEN: ${issues.join("; ")}`);
  }
}
