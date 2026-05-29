/**
 * Paywall fee computation — operator + protocol split.
 *
 * Fee model (two independent parties):
 *
 *   operatorFee  → whoever runs the paid endpoint (app builder sets operatorFeeBps freely)
 *   protocolFee  → Parad0x treasury (fixed at 5 bps on the official commercial rail)
 *
 * Both fees are deducted from priceAtomic — the payer sends the listed price unchanged:
 *
 *   totalAtomic   = priceAtomic          (what the payer sends)
 *   feeAtomic     = operatorFee + protocolFee
 *   providerNet   = priceAtomic - feeAtomic  (what the service provider keeps)
 *
 * Typical configs:
 *   OSS / grant / free path       operatorFeeBps: 0,  protocolFeeBps: 0
 *   Parad0x commercial default    operatorFeeBps: 50, protocolFeeBps: 5  (0.5% + 0.05%)
 *   Third-party builder           operatorFeeBps: <their choice>, protocolFeeBps: 5
 *
 * The 50 bps operator default is Parad0x's own setting for Parad0x-run endpoints.
 * Other builders set their own operatorFeeBps — there is no global rule.
 *
 * All arithmetic is BigInt floor division matching the `bps()` helper in
 * waterfall.ts:  fee = (amount * feeBps) / 10_000  (floors toward zero).
 *
 * Pure function: no I/O, no side effects, safe to call in hot paths.
 */

export interface PaywallFeeResult {
  /** Fee going to the endpoint operator (floor division, may be "0"). */
  operatorFeeAtomic: string;
  /** Fee going to the Parad0x protocol treasury (floor division, may be "0"). */
  protocolFeeAtomic: string;
  /** Sum of operator + protocol fees. */
  totalFeeAtomic: string;
  /** priceAtomic − totalFeeAtomic — what the provider receives after fees. */
  providerNetAtomic: string;
}

function applyBps(amount: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return 0n;
  return (amount * BigInt(feeBps)) / 10_000n;
}

/**
 * Compute operator and protocol fees for a paywall quote.
 *
 * @param priceAtomic    - The listed price (total payer sends).
 * @param operatorFeeBps - Endpoint builder's fee (0–2000 bps). Each builder sets this
 *                         independently. Parad0x's own commercial default is 50 bps (0.5%)
 *                         — that is NOT a global cap or requirement for other builders.
 * @param protocolFeeBps - Parad0x official rail fee (0–100 bps). The official commercial
 *                         config uses 5 bps (0.05%). OSS / grant configs use 0.
 *
 * Returned amounts are decimal strings.  All are "0" when both feeBps are 0.
 *
 * @throws if feeBps are out of valid range or combined fees exceed priceAtomic.
 */
export function computePaywallFees(
  priceAtomic: string,
  operatorFeeBps: number,
  protocolFeeBps: number,
): PaywallFeeResult {
  if (!Number.isInteger(operatorFeeBps) || operatorFeeBps < 0 || operatorFeeBps > 2_000) {
    throw new Error(`operatorFeeBps out of range [0, 2000]: ${operatorFeeBps}`);
  }
  if (!Number.isInteger(protocolFeeBps) || protocolFeeBps < 0 || protocolFeeBps > 100) {
    throw new Error(`protocolFeeBps out of range [0, 100]: ${protocolFeeBps}`);
  }

  const price = BigInt(priceAtomic);
  if (price < 0n) throw new Error("priceAtomic cannot be negative");

  const operatorFee = applyBps(price, operatorFeeBps);
  const protocolFee = applyBps(price, protocolFeeBps);
  const totalFee = operatorFee + protocolFee;

  if (totalFee > price) {
    // Arithmetic can't reach here with valid bps (max combined = 2100 bps = 21% < 100%),
    // but guard defensively.
    throw new Error(`Total fees (${totalFee}) exceed priceAtomic (${price}).`);
  }

  const providerNet = price - totalFee;

  return {
    operatorFeeAtomic: operatorFee.toString(),
    protocolFeeAtomic: protocolFee.toString(),
    totalFeeAtomic: totalFee.toString(),
    providerNetAtomic: providerNet.toString(),
  };
}

/**
 * Validate that a wallet address is not obviously a Solana program ID.
 *
 * Program IDs deployed by this project are 32-byte base58 pubkeys — the same
 * format as normal wallet addresses.  We cannot distinguish them by format
 * alone, but we can check against the known program list from the configs.
 *
 * Call this at PaywallOptions construction time if `operatorFeeRecipient` or
 * `protocolFeeRecipient` are provided.
 *
 * Currently a no-op assertion that the address is a non-empty base58 string of
 * plausible length (32–44 chars).  Pass `knownProgramIds` from your config to
 * add an explicit blocklist check.
 */
export function assertFeeRecipientNotProgramId(
  address: string,
  knownProgramIds: ReadonlySet<string> = new Set(),
): void {
  if (!address || typeof address !== "string") {
    throw new Error("Fee recipient address must be a non-empty string");
  }
  if (address.length < 32 || address.length > 44) {
    throw new Error(`Fee recipient address has invalid length (${address.length}): ${address}`);
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
    throw new Error(`Fee recipient address contains invalid base58 characters: ${address}`);
  }
  if (knownProgramIds.has(address)) {
    throw new Error(
      `Fee recipient address is a known program ID — use a treasury wallet instead: ${address}`,
    );
  }
}
