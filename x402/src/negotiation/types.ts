/**
 * DNA x402 — Agent Price Negotiation Protocol
 *
 * Extends the base x402 flow with a bid/counter-bid handshake before a quote is issued.
 * Servers advertise a floor price; agents bid autonomously within user-set limits.
 *
 * Request header:
 *   x-dnp-offer: <atomic_amount>        — agent's bid for the resource
 *   x-dnp-negotiate-round: <1|2|3>      — current round (server uses to cap back-and-forth)
 *
 * 402 response body additions:
 *   negotiation.enabled                  — server supports negotiation
 *   negotiation.floorPriceAtomic         — minimum price server will accept
 *   negotiation.listedPriceAtomic        — headline price (before negotiation)
 *   negotiation.counterPriceAtomic       — present when server rejects offer; absent when accepted
 *   negotiation.round                    — round number after counter
 *   negotiation.maxRounds                — total rounds server allows
 *
 * When the server accepts an offer the 402 body includes a full paymentRequirements.quote
 * at the agreed price. The client proceeds with the normal commit/finalize flow.
 *
 * When the server counters (offer below floor) the 402 body has only the negotiation block —
 * no quote. The client must retry with a higher offer or give up.
 */

/** Server-side policy attached to `PaywallOptions.negotiation`. */
export interface NegotiationPolicy {
  /** Enables bid/counter-bid flow on this endpoint. Default: false. */
  enabled: boolean;
  /**
   * Minimum price (in atomic units) this server will ever accept.
   * Must be <= PaywallOptions.priceAtomic (the listed headline price).
   */
  floorPriceAtomic: string;
  /**
   * Maximum number of bid/counter rounds before the server stops countering
   * and issues a final quote at floor price.  Default: 2.
   */
  maxRounds?: number;
}

/** Included in the 402 response body when negotiation is enabled (advertisement, no offer). */
export interface NegotiationAdvertisement {
  enabled: true;
  floorPriceAtomic: string;
  listedPriceAtomic: string;
  maxRounds: number;
}

/**
 * Included in the 402 response body when the server rejects an offer with a counter.
 * No paymentRequirements.quote is present — the client must re-bid or give up.
 */
export interface NegotiationCounter extends NegotiationAdvertisement {
  counterPriceAtomic: string;
  round: number;
}

/** Union of what can appear in a 402 body's `negotiation` field. */
export type NegotiationResponse = NegotiationAdvertisement | NegotiationCounter;

/** Result returned by the server-side evaluation function. */
export type NegotiateOfferResult =
  | { accepted: true; agreedPriceAtomic: string }
  | { accepted: false; counterPriceAtomic: string; nextRound: number };

/** Options for the client-side fetchWithNegotiation call. */
export interface NegotiationClientPolicy {
  /**
   * The agent's initial bid (atomic USDC).
   * Should be <= listedPriceAtomic. Can be as low as the server's floor.
   */
  targetPriceAtomic: string;
  /**
   * Hard cap: the agent will never pay more than this amount.
   * Counters above this value cause fetchWithNegotiation to throw.
   */
  maxPriceAtomic: string;
  /**
   * Maximum number of probe-and-retry rounds the client will attempt.
   * Default: 3.
   */
  maxRounds?: number;
}
