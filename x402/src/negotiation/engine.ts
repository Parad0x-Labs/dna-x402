import type { NegotiateOfferResult, NegotiationPolicy } from "./types.js";

/**
 * Evaluate an agent's bid against the server's negotiation policy.
 *
 * Rules:
 *  - offer >= floor  → accepted at min(offer, listed)  (agent can't accidentally overpay)
 *  - offer < floor AND round < maxRounds → counter at floor, increment round
 *  - offer < floor AND round >= maxRounds → accepted at floor (final take-it-or-leave-it)
 *
 * @param offerAtomic       The agent's current bid as a decimal string.
 * @param listedPriceAtomic The server's headline price.
 * @param policy            The server's NegotiationPolicy.
 * @param round             The current negotiation round (1-based).
 */
export function evaluateOffer(
  offerAtomic: string,
  listedPriceAtomic: string,
  policy: NegotiationPolicy,
  round: number,
): NegotiateOfferResult {
  const floor = BigInt(policy.floorPriceAtomic);
  const listed = BigInt(listedPriceAtomic);
  const maxRounds = policy.maxRounds ?? 2;

  let offer: bigint;
  try {
    offer = BigInt(offerAtomic);
  } catch {
    offer = 0n;
  }

  if (offer < 0n) {
    offer = 0n;
  }

  if (offer >= floor) {
    // Cap at listed so agents can't accidentally overpay the headline price.
    const agreed = offer < listed ? offer : listed;
    return { accepted: true, agreedPriceAtomic: agreed.toString() };
  }

  if (round >= maxRounds) {
    // Last round — issue at floor unconditionally.
    return { accepted: true, agreedPriceAtomic: floor.toString() };
  }

  return { accepted: false, counterPriceAtomic: floor.toString(), nextRound: round + 1 };
}

/**
 * Parse and clamp the `x-dnp-negotiate-round` header value.
 * Returns 1 if the header is absent or unparseable.
 */
export function parseNegotiateRound(rawHeader: string | undefined): number {
  if (!rawHeader) {
    return 1;
  }
  const parsed = parseInt(rawHeader, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}
