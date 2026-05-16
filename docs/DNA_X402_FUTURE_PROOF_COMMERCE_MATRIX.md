# DNA x402 Future-Proof Commerce Matrix

Purpose: show the programmable commerce surface without unlocking unsafe production paths. Status labels are intentionally constrained.

Allowed status labels:

- `READY_AFTER_PROD_GATES`
- `SUPPORTED_SANDBOX`
- `ARCHITECTURE_READY`
- `REQUIRES_ADAPTER`
- `REQUIRES_COUNSEL`
- `REQUIRES_MANUAL_OPS`
- `BLOCKED_BY_POLICY`
- `DO_NOT_BUILD_YET`

## Low-Risk Near-Term

| Use case | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Paid APIs | marketplace, policy, receipts, fees | Solana USDC default | Low | Seller profile, tax hooks | Receipt binds request/response/payment/policy/fee | Live Postgres, monitoring, counsel low-risk scope | `READY_AFTER_PROD_GATES` |
| Paid MCP tools | SDK, sandbox, webhooks | Solana USDC default | Low | Seller profile | Tool result digest in receipt | SDK compatibility and sandbox proof | `ARCHITECTURE_READY` |
| Paid data feeds | marketplace, receipts, eventPrivacy | Solana USDC default | Low to medium | Seller profile, source reputation | Response digest and freshness metadata | Low-risk seller gate | `ARCHITECTURE_READY` |
| Paid file/content access | marketplace, privacy, receipts | Solana USDC default | Low | Seller profile, privacy scan | File/content digest in receipt | PII guard and abuse reporting | `SUPPORTED_SANDBOX` |
| Alert services | webhooks, marketplace, receipts | Solana USDC default | Low | Seller profile | Webhook delivery and receipt evidence | Webhook HTTP mayhem and monitoring | `ARCHITECTURE_READY` |
| API subscriptions | fees, settlement, receipts | Solana USDC default | Medium | Seller profile, tax hooks | Subscription period and receipt chain | Subscription billing gate | `REQUIRES_ADAPTER` |
| Builder-monetized APIs/agents | fees, marketplace, receipts | Solana USDC default | Medium | Builder profile, seller profile, tax hooks | FeeWaterfallV2 and receipt-bound accrual | Direct split gate for live collection | `ARCHITECTURE_READY` |

## Marketplace

| Use case | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seller listings | marketplace, policy, governance | Solana USDC default | Category-dependent | Seller profile, tax profile threshold | Signed manifest version | Gate 2 plus live Postgres | `SUPPORTED_SANDBOX` |
| Seller shops | marketplace, identity, reputation | Solana USDC default | Category-dependent | Domain/social/KYB optional | Manifest hash and seller badges | Seller verification scope | `ARCHITECTURE_READY` |
| Capability discovery | marketplace search, eventPrivacy | None | Low | Public seller fields only | Signed manifest metadata | Graph privacy gate | `SUPPORTED_SANDBOX` |
| Quote comparison | settlement, fees, policy | Solana USDC default | Low | Buyer/seller policy input | Quote hash and fee waterfall | Checkout sandbox proof | `SUPPORTED_SANDBOX` |
| Seller analytics | eventPrivacy, reputation | None | Medium | Seller role access | Aggregated thresholded events | Graph privacy controls | `ARCHITECTURE_READY` |
| Buyer receipt vault | receipts, privacy | None | Low | Buyer account/session | Offline receipt verifier | Privacy/data-rights review | `REQUIRES_ADAPTER` |
| Abuse reports | governance, policy | None | Medium | Reporter and evidence refs | Audit event references only | Appeal and review staffing | `ARCHITECTURE_READY` |
| Appeals | governance, admin | None | Medium | Reviewer roles | Audited restore/reject action | Named operators | `ARCHITECTURE_READY` |

## Agent Economy

| Use case | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent-to-agent payments | permissions, receipts, settlement | Solana USDC default | Medium | Agent spend policy, owner wallet | Receipt chain and spend simulation | No unattended live signing; active approval scope | `ARCHITECTURE_READY` |
| Sub-agent delegation | permissions | Solana USDC default | Medium | Parent scope and revocation | Parent-child receipt chain | Delegation tests | `REQUIRES_ADAPTER` |
| Multi-hop receipts | receipts, proof | None | Medium | Agent IDs and policy input | Chained receipts | Receipt verifier package | `ARCHITECTURE_READY` |
| Bundle workflows | economics, receipts | Solana USDC default | Medium | Agent/seller profiles | Dependency graph and receipt chain | Bundle loop/depth mayhem | `SUPPORTED_SANDBOX` |
| Reseller workflows | marketplace, fees, receipts | Solana USDC default | Medium | Seller tax and reputation | Split receipt and fee waterfall | Fee/no-double-charge tests | `REQUIRES_COUNSEL` |
| Agent budget simulation | permissions | None | Low | Owner/session policy | Simulated spend trace | UI and SDK adapter | `ARCHITECTURE_READY` |
| Emergency revoke | permissions, emergency | None | Low | Owner/admin action | Audited revoke event | Runtime kill switch tests | `ARCHITECTURE_READY` |
| Human approval thresholds | permissions, UX | Solana USDC default | Low | Owner local approval | Approval reference in receipt | Browser-local signing proof | `REQUIRES_ADAPTER` |
| Unattended live agent spending | permissions | Live funds | High | Strong custody review | Scoped signer proof | Separate counsel/custody gate | `DO_NOT_BUILD_YET` |

## Compute

| Use case | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GPU inference | compute, receipts, disputes | Solana USDC default | Medium | Provider profile, tax hooks | Input/output/log digest and provider signature | Compute timeout/refund/metering tests | `ARCHITECTURE_READY` |
| Batch compute | compute queue | Solana USDC default | Medium | Provider profile | Job state receipt | Queue and retry adapter | `REQUIRES_ADAPTER` |
| Rendering | compute, storage | Solana USDC default | Medium | Provider profile | Artifact digest | Artifact storage adapter | `REQUIRES_ADAPTER` |
| Model fine-tuning jobs | compute, privacy | Solana USDC default | Higher | Provider profile, data controls | Environment/output digest | Privacy and data retention review | `REQUIRES_COUNSEL` |
| Browser automation sessions | compute, policy | Solana USDC default | Medium | Provider profile | Session transcript digest where safe | Lawful-use policy gate | `REQUIRES_COUNSEL` |
| Usage metering | compute, fees | Solana USDC default | Medium | Provider profile | Meter proof and cap receipt | Metering no-overbill tests | `ARCHITECTURE_READY` |

## Financial / Market Verticals

| Use case | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Polymarket agents | vertical/polymarket, policy | pUSD via Polymarket deposit wallet | High | User-owned deposit wallet, browser-local signer | Signed order fixture, withdrawal intent, copy lot ledger | Polymarket live gate and counsel | `DO_NOT_BUILD_YET` |
| Copy-agent fees | fees, copy ledger | pUSD accounting | High | Alpha/follower profiles | Positive finalized copied-lot PnL only | Counsel and finalized PnL tests | `DO_NOT_BUILD_YET` |
| Prediction-market data feeds | marketplace, data feeds | Solana USDC default | Medium | Seller profile | Data feed response digest | Category policy review | `REQUIRES_COUNSEL` |
| Market alert feeds | webhooks, marketplace | Solana USDC default | Medium | Seller profile | Alert payload digest | Webhook HTTP mayhem | `REQUIRES_COUNSEL` |
| Trading research agents | marketplace, policy | Solana USDC default | Medium to high | Seller profile and disclosures | Research output digest | Counsel and jurisdiction gating | `REQUIRES_COUNSEL` |

## Commerce Primitives

| Primitive | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fixed price | fees, receipts | Solana USDC default | Low | Seller profile | Quote/commit/finalize receipt | Core loop regression | `SUPPORTED_SANDBOX` |
| Metered usage | fees, receipts | Solana USDC default | Medium | Seller profile | Usage digest and cap | Metering tests | `ARCHITECTURE_READY` |
| Streaming payments | settlement, receipts | Solana USDC default | Medium | Seller profile | Stream receipt and replay guard | Stream reuse mayhem | `ARCHITECTURE_READY` |
| Prepaid credits | fees, receipts | Solana USDC default | Medium | Seller tax hooks | Credit ledger and receipt chain | Ledger persistence | `REQUIRES_ADAPTER` |
| Subscriptions | fees, webhooks | Solana USDC default | Medium | Seller tax hooks | Period receipt and cancellation audit | Billing adapter | `REQUIRES_ADAPTER` |
| Refunds | disputes, receipts | Solana USDC default | Medium | Seller profile | Refund event and receipt reference | Refund policy tests | `ARCHITECTURE_READY` |
| Escrow / milestone release | disputes, fees | Solana USDC default | Medium to high | Seller/buyer profile | Milestone proof | Counsel and dispute ops | `REQUIRES_COUNSEL` |
| Split payments | fees | Solana USDC default | Medium | Tax profiles for recipients | Fee waterfall | No-double-charge tests | `ARCHITECTURE_READY` |
| Affiliate fees | fees | Solana USDC default | Medium | Recipient tax hooks | Fee line and basis | Counsel/tax review | `REQUIRES_COUNSEL` |
| Builder fees | fees | Solana USDC default | Medium | Builder profile and treasury recipient | FeeWaterfallV2 line and receipt hash | Display/accrual Public Beta; direct split gate for live collection | `ARCHITECTURE_READY` |
| Success fees | fees | Solana USDC default | Medium to high | Recipient tax hooks | Finalized positive outcome only | Counsel and accounting tests | `REQUIRES_COUNSEL` |
| Auctions | economics, receipts | Solana USDC default | Medium | Seller profile | Commit/reveal audit trail | Auction mayhem | `SUPPORTED_SANDBOX` |
| Sealed bids | economics, receipts | Solana USDC default | Medium | Seller profile | Salted commit/reveal | Sealed bid tests | `SUPPORTED_SANDBOX` |
| Reverse auctions | economics | Solana USDC default | Medium | Seller profile | Deterministic settlement | Auction adapter | `REQUIRES_ADAPTER` |
| Bundles | economics, receipts | Solana USDC default | Medium | Seller profiles | Dependency graph | Bundle mayhem | `SUPPORTED_SANDBOX` |
| Resales | marketplace, fees | Solana USDC default | Medium to high | Seller tax hooks | Original receipt reference | Counsel review | `REQUIRES_COUNSEL` |

## Physical / High-Risk Future

| Use case | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Physical goods | physical-gated, disputes | Solana USDC default | High | Verified seller, tax profile | Shipping/tracking/dispute audit | Physical goods gate and counsel | `DO_NOT_BUILD_YET` |
| Shipping/tracking | physical-gated | None | High | Verified seller | Tracking event audit | Manual ops and dispute staffing | `REQUIRES_MANUAL_OPS` |
| Payout freeze | disputes | Solana USDC default | High | Seller profile | Freeze/unfreeze audit | Counsel and operator approval | `REQUIRES_COUNSEL` |
| Regulated goods | policy, governance | Any | Critical | KYB/KYC, legal review | Evidence refs | Category-specific approval | `BLOCKED_BY_POLICY` |
| High-risk categories | policy, governance | Any | Critical | KYB/KYC, legal review | Policy decision evidence | High-risk category gate | `DO_NOT_BUILD_YET` |

## Settlement Future

| Settlement path | Module path | Policy risk | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- |
| Solana USDC | settlement, verifier | Low to medium | Transfer proof and receipt digest | Live money gate | `READY_AFTER_PROD_GATES` |
| Base USDC | settlement adapter | Medium | Verifier adapter | Multi-chain settlement gate | `REQUIRES_ADAPTER` |
| Arbitrum USDC | settlement adapter | Medium | Verifier adapter | Multi-chain settlement gate | `REQUIRES_ADAPTER` |
| Polygon USDC | settlement adapter | Medium | Verifier adapter | Multi-chain settlement gate | `REQUIRES_ADAPTER` |
| Ethereum USDC | settlement adapter | Medium | Verifier adapter | Multi-chain settlement gate | `REQUIRES_ADAPTER` |
| Other stablecoins | token registry | Medium | Token registry and depeg logic | Counsel and token-risk review | `REQUIRES_COUNSEL` |
| Bridge-assisted settlement | bridge adapter | High | Bridge quote/status proofs | Bridge risk disclosure and tests | `REQUIRES_COUNSEL` |
| Broad multi-chain production settlement | settlement registry | High | All adapter evidence | Multi-chain gate approval | `DO_NOT_BUILD_YET` |

## Enterprise Future

| Use case | Module path | Settlement | Policy risk | Identity / tax | Proof requirement | Launch gate | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Organization accounts | identity, governance | None | Low | Organization profile | Role audit | Org adapter | `REQUIRES_ADAPTER` |
| Team roles | admin, governance | None | Medium | Role separation | Admin audit | Operator review | `ARCHITECTURE_READY` |
| API keys | SDK, permissions | Solana USDC default | Medium | Owner account | Scoped key audit | Key management adapter | `REQUIRES_ADAPTER` |
| Audit exports | governance, receipts | None | Low | Admin role | Export hash | Admin runbook | `ARCHITECTURE_READY` |
| SLA profiles | marketplace | None | Low | Seller profile | Manifest version | Seller wizard polish | `ARCHITECTURE_READY` |
| Invoices | tax, fees | Solana USDC default | Medium | Tax profile | Fee waterfall and receipt | Counsel/tax review | `REQUIRES_COUNSEL` |
| Tax exports | tax | None | Medium | Seller tax profile | Redacted export | Tax/legal review | `ARCHITECTURE_READY` |
| Compliance exports | policy, governance | None | Medium | Admin/compliance role | Evidence refs | Counsel review | `ARCHITECTURE_READY` |
| Private marketplace mode | marketplace, policy | Solana USDC default | Low to medium | Approved seller network | Signed manifest and receipts | Enterprise policy pack | `REQUIRES_ADAPTER` |
| Approved seller networks | identity, reputation | Solana USDC default | Medium | KYB optional | Network membership proof | Operator approval | `REQUIRES_ADAPTER` |
| Enterprise policy packs | policy | None | Medium | Organization profile | Policy version hash | Counsel/operator review | `REQUIRES_COUNSEL` |

## Non-Overclaim Lock

Physical goods, Polymarket live movement, public netting, high-risk categories, broad multi-chain production settlement, and unattended agent spending with live funds are not launchable from this matrix. They remain gated by policy, counsel, operators, monitoring, and explicit approvals.
