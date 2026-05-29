/**
 * Client-side agent price negotiation for DNA x402.
 *
 * Agents bid autonomously within user-set limits.  The user sets two numbers:
 *   targetPriceAtomic  — starting bid (e.g. 70 % of listed price)
 *   maxPriceAtomic     — hard cap; the agent will never pay more than this
 *
 * fetchWithNegotiation handles the probe → counter → accept loop invisibly,
 * then delegates the actual payment to the standard fetchWith402 flow.
 *
 * Usage:
 *   const result = await fetchWithNegotiation(
 *     "https://provider.example/api/inference",
 *     {
 *       wallet: myAgentWallet,
 *       maxSpendAtomic: "10000",
 *       negotiation: { targetPriceAtomic: "3000", maxPriceAtomic: "5000" },
 *     },
 *   );
 */

import { fetchWith402 } from "../client.js";
import type { FetchWith402Options, FetchWith402Result } from "../client.js";
import type { NegotiationClientPolicy } from "../negotiation/types.js";

export interface FetchWithNegotiationOptions extends FetchWith402Options {
  negotiation: NegotiationClientPolicy;
}

interface ProbeOutcome {
  /** The server accepted our offer; we should now call fetchWith402 with this price as the offer. */
  accepted: true;
  agreedPriceAtomic: string;
}

interface ProbeCountered {
  accepted: false;
  counterPriceAtomic: string;
  nextRound: number;
}

interface ProbeNonNegotiable {
  /** Server is not negotiation-aware; proceed at listed price. */
  accepted: "passthrough";
}

interface ProbePassthrough {
  /** Resource no longer requires payment. */
  accepted: "free";
  response: Response;
}

type ProbeResult = ProbeOutcome | ProbeCountered | ProbeNonNegotiable | ProbePassthrough;

function mergeHeaders(
  base: RequestInit["headers"],
  extra: Record<string, string>,
): Record<string, string> {
  const baseEntries = base instanceof Headers
    ? Object.fromEntries(base.entries())
    : (Array.isArray(base)
      ? Object.fromEntries(base as [string, string][])
      : (base as Record<string, string> | undefined ?? {}));
  return { ...baseEntries, ...extra };
}

async function probe(
  url: string,
  offerAtomic: string,
  round: number,
  requestInit: RequestInit,
): Promise<ProbeResult> {
  const headers = mergeHeaders(requestInit.headers, {
    "x-dnp-offer": offerAtomic,
    "x-dnp-negotiate-round": String(round),
  });

  const res = await fetch(url, { ...requestInit, headers });

  if (res.status !== 402) {
    return { accepted: "free", response: res };
  }

  let body: Record<string, unknown>;
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    // Unparseable 402 — treat as non-negotiable.
    return { accepted: "passthrough" };
  }

  const neg = body.negotiation as {
    enabled?: boolean;
    counterPriceAtomic?: string;
    round?: number;
  } | undefined;

  const requirements = body.paymentRequirements as { quote?: { quoteId?: string } } | undefined;
  const hasQuote = !!requirements?.quote?.quoteId;

  if (!neg?.enabled) {
    // Server doesn't know about negotiation — pass through at listed price.
    return { accepted: "passthrough" };
  }

  if (hasQuote) {
    // Server accepted the offer and issued a full quote.
    // The quoted totalAtomic is the agreed price.
    const agreedPrice = (requirements?.quote as { totalAtomic?: string } | undefined)?.totalAtomic
      ?? offerAtomic;
    return { accepted: true, agreedPriceAtomic: agreedPrice };
  }

  if (neg.counterPriceAtomic) {
    return {
      accepted: false,
      counterPriceAtomic: neg.counterPriceAtomic,
      nextRound: neg.round ?? round + 1,
    };
  }

  // Negotiation-enabled but no counter and no quote — shouldn't happen; pass through.
  return { accepted: "passthrough" };
}

/**
 * Wraps fetchWith402 with an autonomous bid/counter-bid loop.
 *
 * The negotiation loop runs before payment: it discovers the lowest price the
 * server will accept, then delegates the commit/finalize flow to fetchWith402
 * at that agreed price.
 *
 * Throws if:
 *  - The server's counter-offer exceeds `negotiation.maxPriceAtomic`.
 *  - fetchWith402 throws (e.g. spend limits, payment failure).
 */
export async function fetchWithNegotiation(
  url: string,
  options: FetchWithNegotiationOptions,
): Promise<FetchWith402Result> {
  const { negotiation, ...baseOptions } = options;
  const maxRounds = negotiation.maxRounds ?? 3;

  let currentOffer = negotiation.targetPriceAtomic;
  let currentRound = 1;

  while (currentRound <= maxRounds) {
    const outcome = await probe(url, currentOffer, currentRound, {
      method: options.method ?? "GET",
      headers: options.headers,
    });

    if (outcome.accepted === "free") {
      return { response: outcome.response };
    }

    if (outcome.accepted === "passthrough") {
      // Server not negotiation-aware — pay at whatever price is listed, capped at maxPriceAtomic.
      return fetchWith402(url, {
        ...baseOptions,
        maxPriceAtomic: negotiation.maxPriceAtomic,
      });
    }

    if (outcome.accepted === true) {
      // Server accepted our bid.  Call fetchWith402 with the same offer header so the
      // server re-creates the quote at agreed price (the probe quote expires naturally).
      return fetchWith402(url, {
        ...baseOptions,
        maxPriceAtomic: negotiation.maxPriceAtomic,
        headers: mergeHeaders(options.headers, {
          "x-dnp-offer": outcome.agreedPriceAtomic,
          "x-dnp-negotiate-round": String(currentRound),
        }),
      });
    }

    // Server countered.
    const counter = outcome.counterPriceAtomic;
    if (BigInt(counter) > BigInt(negotiation.maxPriceAtomic)) {
      throw new Error(
        `Negotiation failed: server counter ${counter} exceeds agent max ${negotiation.maxPriceAtomic}`,
      );
    }

    currentOffer = counter;
    currentRound = outcome.nextRound;
  }

  // All rounds exhausted without a final accept — pay at whatever the last agreed offer was.
  return fetchWith402(url, {
    ...baseOptions,
    maxPriceAtomic: negotiation.maxPriceAtomic,
    headers: mergeHeaders(options.headers, {
      "x-dnp-offer": currentOffer,
      "x-dnp-negotiate-round": String(currentRound),
    }),
  });
}
