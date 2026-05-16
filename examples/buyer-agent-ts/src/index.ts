const baseUrl = process.env.X402_STAGING_API_URL ?? "http://127.0.0.1:4021";
const maxSpendAtomic = process.env.X402_MAX_SPEND_ATOMIC ?? "100000";

export function buildQuoteUrl(resource = "/resource", amountAtomic = "100000"): string {
  const url = new URL("/quote", baseUrl);
  url.searchParams.set("resource", resource);
  url.searchParams.set("amountAtomic", amountAtomic);
  return url.toString();
}

export function buildCommitPayload(quoteId: string): Record<string, string> {
  return {
    quoteId,
    payerCommitment32B: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

export function assertSpendAllowed(amountAtomic: string): void {
  if (BigInt(amountAtomic) > BigInt(maxSpendAtomic)) {
    throw new Error("spend limit exceeded");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertSpendAllowed("100000");
  console.log("buyer-agent: quote request prepared", buildQuoteUrl());
  console.log("buyer-agent: commit payload prepared", buildCommitPayload("quote-demo"));
  console.log("buyer-agent: manual wallet signing required before finalize");
}
