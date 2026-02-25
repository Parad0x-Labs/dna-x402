export function redactValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  const trimmed = text.trim();
  if (trimmed.length <= 20) {
    return `${trimmed} (len=${trimmed.length})`;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)} (len=${trimmed.length})`;
}

export function headerNamesOnly(headers: Record<string, string | undefined>): string[] {
  return Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
}

export function redactSensitiveHeaders(headers: Record<string, string | undefined>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === "payment-signature"
      || lower === "x-payment"
      || lower === "x-402-payment"
      || lower === "payment-required"
      || lower === "x-payment-required"
      || lower === "x-402-payment-required"
    ) {
      out[lower] = redactValue(value);
    }
  }
  return out;
}
