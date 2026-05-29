/**
 * Paywall fee computation — operator + protocol split.
 *
 * Both fees are deducted from the listed priceAtomic (provider pays the fee,
 * not the payer).  This matches the waterfall.ts model:
 *
 *   totalAtomic    = priceAtomic          (what the payer sends — unchanged)
 *   feeAtomic      = operatorFee + protocolFee
 *   providerNet    = priceAtomic - feeAtomic  (what the endpoint owner receives)
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
 * @param operatorFeeBps - Endpoint operator's fee in basis points (0–2000, default 0).
 * @param protocolFeeBps - Parad0x protocol treasury fee in basis points (0–100, default 0).
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
