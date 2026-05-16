# DNA x402 Policy And Compliance Layer

Date: 2026-05-15

## Purpose

Policy is separate from payment verification. A payment can be technically valid and still blocked by policy, sanctions, tax, jurisdiction, seller risk, graph privacy, or governance controls.

## Implemented Model

`PolicyInputV1` is frozen as the forward-compatible policy input schema. Missing signals normalize to `UNKNOWN` or `MISSING`, not to fake safe values.

Policy decisions produce:

- stable `decisionId`
- `state`
- reason codes
- normalized input hash
- policy version
- timestamp

Policy states:

- `ALLOW`
- `ALLOW_WITH_LIMITS`
- `REVIEW_REQUIRED`
- `BLOCK`
- `SUSPEND_SELLER`
- `SUSPEND_BUYER`
- `DISABLE_LISTING`

## Current Controls

- sanctions hit blocks
- restricted categories block
- restricted capabilities block
- regulated goods block
- public physical goods require review
- failed KYC/KYB can suspend buyer or seller
- policy strikes can suspend seller
- high dispute rate requires review
- missing tax profile can block payout above threshold
- emergency, marketplace, and finalize pause flags block relevant actions

## Compliance Adapter Boundary

The code defines provider boundaries and must not hardcode one vendor:

- sanctions screening adapter
- KYC/KYB adapter
- tax profile status adapter
- jurisdiction flag adapter

## References

- FinCEN CVC guidance: https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-persons-administering
- OFAC virtual currency guidance: https://ofac.treasury.gov/recent-actions/20211015
