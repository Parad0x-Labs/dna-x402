# DNA x402 Tax And Reporting Hooks

Date: 2026-05-15

## Purpose

Marketplace receipts contain enough data to calculate seller gross proceeds. That must become a reporting hook before public seller payouts scale.

## Implemented Model

`SellerTaxProfile` tracks:

- country
- tax residency
- tax ID status
- W-9/W-8 status
- DAC7 status
- withholding status

`SellerTaxAggregate` tracks:

- seller profile ID
- calendar year
- gross payments
- transaction count
- refunds
- fees
- net payout estimate
- reportable jurisdictions
- threshold status

## Rules

- Thresholds are configurable.
- Refunds do not erase gross history.
- Missing tax profile can block payout above configured thresholds.
- Tax export redacts buyer personal data unless legally required.

## References

- IRS 1099-K FAQ: https://www.irs.gov/newsroom/form-1099-k-faqs-general-information
- IRS 1042-S: https://www.irs.gov/forms-pubs/about-form-1042-s
- EU DAC7: https://taxation-customs.ec.europa.eu/taxation/tax-transparency-cooperation/administrative-co-operation-and-mutual-assistance/dac7_en
- EU DAC8: https://taxation-customs.ec.europa.eu/taxation/tax-transparency-cooperation/administrative-co-operation-and-mutual-assistance/directive-administrative-cooperation-dac/dac8_en
