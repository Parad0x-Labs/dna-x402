import { parseAtomic, toAtomicString } from "../feePolicy.js";
import {
  SellerTaxAggregate,
  SellerTaxProfile,
  SellerTaxTransaction,
  TaxThresholdConfig,
  TaxThresholdStatus,
} from "./types.js";

export const DEFAULT_US_1099K_THRESHOLD: TaxThresholdConfig = {
  jurisdiction: "US",
  grossPaymentsAtomic: "20000000000",
  transactionCount: 200,
  nearThresholdRatio: 0.8,
};

export class TaxAggregator {
  private readonly transactions: SellerTaxTransaction[] = [];

  constructor(private readonly thresholds: TaxThresholdConfig[] = [DEFAULT_US_1099K_THRESHOLD]) {}

  record(transaction: SellerTaxTransaction): void {
    this.transactions.push(transaction);
  }

  aggregate(sellerProfileId: string, calendarYear: number): SellerTaxAggregate {
    const rows = this.transactions.filter((row) => row.sellerProfileId === sellerProfileId && row.calendarYear === calendarYear);
    let gross = 0n;
    let refunds = 0n;
    let fees = 0n;
    const jurisdictions = new Set<string>();

    for (const row of rows) {
      gross += parseAtomic(row.grossAmountAtomic);
      refunds += parseAtomic(row.refundAmountAtomic ?? "0");
      fees += parseAtomic(row.feeAmountAtomic);
      if (row.jurisdiction) {
        jurisdictions.add(row.jurisdiction);
      }
    }

    const net = gross - refunds - fees;
    return {
      sellerProfileId,
      calendarYear,
      grossPayments: toAtomicString(gross),
      transactionCount: rows.length,
      refunds: toAtomicString(refunds),
      fees: toAtomicString(fees),
      netPayoutEstimate: toAtomicString(net > 0n ? net : 0n),
      reportableJurisdictions: [...jurisdictions].sort(),
      thresholdStatus: this.thresholdStatus(gross, rows.length, [...jurisdictions]),
    };
  }

  canPayout(profile: SellerTaxProfile, aggregate: SellerTaxAggregate): { ok: boolean; reason?: string } {
    if (aggregate.thresholdStatus === "ABOVE_THRESHOLD" && profile.taxIdStatus !== "VALIDATED") {
      return { ok: false, reason: "tax_profile_required_above_threshold" };
    }
    if (aggregate.reportableJurisdictions.includes("EU") && profile.dac7Status === "DATA_MISSING") {
      return { ok: false, reason: "dac7_profile_required" };
    }
    return { ok: true };
  }

  exportAggregate(profile: SellerTaxProfile, aggregate: SellerTaxAggregate): Record<string, unknown> {
    return {
      sellerProfileId: aggregate.sellerProfileId,
      country: profile.country,
      taxResidency: profile.taxResidency,
      taxIdStatus: profile.taxIdStatus,
      usFormStatus: profile.usFormStatus ?? "NONE",
      dac7Status: profile.dac7Status ?? "NOT_APPLICABLE",
      withholdingStatus: profile.withholdingStatus ?? "UNKNOWN",
      calendarYear: aggregate.calendarYear,
      grossPayments: aggregate.grossPayments,
      transactionCount: aggregate.transactionCount,
      refunds: aggregate.refunds,
      fees: aggregate.fees,
      netPayoutEstimate: aggregate.netPayoutEstimate,
      reportableJurisdictions: aggregate.reportableJurisdictions,
      thresholdStatus: aggregate.thresholdStatus,
    };
  }

  private thresholdStatus(gross: bigint, transactionCount: number, jurisdictions: string[]): TaxThresholdStatus {
    const candidates = this.thresholds.filter((threshold) => jurisdictions.length === 0 || jurisdictions.includes(threshold.jurisdiction));
    for (const threshold of candidates.length > 0 ? candidates : this.thresholds) {
      const grossThreshold = parseAtomic(threshold.grossPaymentsAtomic);
      const nearGross = BigInt(Math.floor(Number(grossThreshold) * threshold.nearThresholdRatio));
      const nearTx = Math.floor(threshold.transactionCount * threshold.nearThresholdRatio);
      if (gross > grossThreshold && transactionCount > threshold.transactionCount) {
        return "ABOVE_THRESHOLD";
      }
      if (gross >= nearGross || transactionCount >= nearTx) {
        return "NEAR_THRESHOLD";
      }
    }
    return "BELOW_THRESHOLD";
  }
}
