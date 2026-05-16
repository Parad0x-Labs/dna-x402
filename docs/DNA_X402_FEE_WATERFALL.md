# DNA x402 Fee Waterfall

Date: 2026-05-15

## Purpose

Fee math must be canonical. No endpoint should hide fee logic.

## Implemented Models

`FeeWaterfall` remains the compatibility model for existing endpoints. `FeeWaterfallV2` is the canonical builder-aware model for new x402 commerce flows.

`FeeWaterfallV2` tracks:

- gross amount
- token
- decimals
- provider amount
- total fees
- total buyer cost
- line-level DNA platform fee
- line-level builder/integrator fee
- line-level affiliate/referrer fee
- line-level alpha success fee
- network fee estimate and refund reserve when configured
- buyer/seller visibility
- collection mode and collection status
- recipient and recipient type
- proof requirement for gated direct split finalize
- no-double-charge key
- stable fee waterfall hash

## Rules

- Every fee has a source, recipient, basis, rounding rule, and refund behavior.
- Total explicit fees cannot exceed gross.
- Duplicate fee assessment is rejected through `noDoubleChargeKey`.
- DNA platform fee is first-class and cannot be overridden by builder or affiliate fees.
- Builder fees are visible in quotes and receipt-bound through `feeWaterfallHash`.
- Builder fees can run in `display_only` or `builder_accrual` mode for Public Beta.
- DNA 10 bps direct split collection is implemented and real-mainnet dust-tested for approved Public Beta flows only. Finalize requires provider and DNA treasury proofs before receipt issuance.
- Public direct split collection remains gated until counsel review, public-production backup operators, and explicit live-gate approval are complete.
- Legacy `FEE_BPS`, `BASE_FEE_ATOMIC`, and `MIN_FEE_ATOMIC` must be zero when canonical direct split platform fees are enabled; hidden legacy fee stacking is rejected.
- Dust amounts that cannot represent required bps fees fail closed instead of silently dropping the fee.
- Polymarket V1 keeps builder fee `0 bps`.
- Polymarket V1 keeps DNA notional trade fee off.
- Alpha fee only applies to positive finalized copied-lot PnL.

## Test Coverage

Focused tests cover:

- DNA 10 bps fee calculation
- builder bps calculation
- affiliate and alpha lines
- caps
- dust fail-closed behavior
- no-double-charge stability
- stable fee waterfall hash
- builder status rejection
- accrual record creation
- gated direct split proof requirements
- HTTP finalize with provider + DNA treasury split proofs
- missing DNA proof rejection
- wrong DNA treasury recipient rejection
- underpaid DNA treasury proof rejection
- direct split proof replay rejection

Server mayhem covers builder fee quote visibility, receipt binding, hidden fee rejection, cap violation rejection, suspended builder rejection, direct split missing proofs, wrong DNA/builder recipient, proof replay, fee waterfall tamper paths, and server finalize receipt binding for collected direct split lines.
