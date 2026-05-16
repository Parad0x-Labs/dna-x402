export type TaxIdStatus = "NOT_COLLECTED" | "PENDING" | "VALIDATED" | "FAILED" | "NOT_REQUIRED";
export type UsFormStatus = "NONE" | "W9_PENDING" | "W9_VALIDATED" | "W8_PENDING" | "W8_VALIDATED";
export type Dac7Status = "NOT_APPLICABLE" | "DATA_MISSING" | "READY" | "REPORTED";
export type WithholdingStatus = "UNKNOWN" | "NOT_REQUIRED" | "REQUIRED" | "APPLIED";
export type TaxThresholdStatus = "BELOW_THRESHOLD" | "NEAR_THRESHOLD" | "ABOVE_THRESHOLD";

export interface SellerTaxProfile {
  sellerProfileId: string;
  country?: string;
  taxResidency?: string;
  taxIdStatus: TaxIdStatus;
  usFormStatus?: UsFormStatus;
  dac7Status?: Dac7Status;
  withholdingStatus?: WithholdingStatus;
}

export interface SellerTaxAggregate {
  sellerProfileId: string;
  calendarYear: number;
  grossPayments: string;
  transactionCount: number;
  refunds: string;
  fees: string;
  netPayoutEstimate: string;
  reportableJurisdictions: string[];
  thresholdStatus: TaxThresholdStatus;
}

export interface TaxThresholdConfig {
  jurisdiction: string;
  grossPaymentsAtomic: string;
  transactionCount: number;
  nearThresholdRatio: number;
}

export interface SellerTaxTransaction {
  sellerProfileId: string;
  buyerActorId?: string;
  receiptId: string;
  calendarYear: number;
  grossAmountAtomic: string;
  feeAmountAtomic: string;
  refundAmountAtomic?: string;
  jurisdiction?: string;
}
