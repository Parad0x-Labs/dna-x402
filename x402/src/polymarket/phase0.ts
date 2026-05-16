export const PHASE0_EXIT_CRITERIA = [
  "Deposit wallet creation works through official/current SDK path.",
  "POLY_1271 / signatureType 3 order signing works.",
  "Exact maker/signer/funder/API-key/owner-session semantics are proven and captured in fixture tests.",
  "Deposit wallet is confirmed as funder.",
  "Builder code attachment is proven in signed order payload.",
  "Approval batch works.",
  "pUSD transfer batch works.",
  "Withdrawal works: quote -> final user confirmation -> withdraw address -> signed pUSD transfer -> status tracking.",
  "Phantom/EVM compatibility decision is documented.",
  "No backend key storage/signing path exists.",
  "Red tests are in place for all blocker risks.",
] as const;

export interface PhantomEvmCompatibilityDecision {
  decision: "phantom_evm_supported" | "standard_evm_wallet_required";
  documented: boolean;
  evidencePath: string;
  reason: string;
}

export function assertPhase0NotPassedForProduction(phase0Passed: boolean): void {
  if (!phase0Passed) {
    throw new Error("Production money movement is blocked until Polymarket Phase 0 exit criteria pass.");
  }
}

export function assertCompatibilityDecisionRecorded(decision: PhantomEvmCompatibilityDecision): void {
  if (!decision.documented || !decision.evidencePath || !decision.reason) {
    throw new Error("Phantom/EVM compatibility decision must be documented before Phase 0 can pass.");
  }
}
