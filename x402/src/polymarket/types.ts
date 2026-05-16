export const LOCKED_V1_RULES = [
  "No production money movement before Phase 0 passes.",
  "No backend private key/session key storage.",
  "No backend signing.",
  "No hosted unattended trading in V1.",
  "V1 copy/auto trading only runs while the user has an active browser session and local signer available.",
  "pUSD/USD is the only accounting balance.",
  "Solana USDC is the default funding/withdrawal UX.",
  "SOL is quote/display-only unless executing a live bridge quote.",
  "Polymarket trading uses a user-owned deposit wallet controlled by an owner/session signer.",
  "Use deposit wallet as funder with POLY_1271 / signatureType = 3.",
  "Exact CLOB v2 maker, signer, funder, API-key, owner/session-signer semantics must be proven by live TS SDK fixture before production.",
  "Builder fee is 0 bps at launch.",
  "DNA per-order notional fee is off in V1.",
  "Alpha fee is 2% of positive finalized copied-lot PnL only.",
  "Withdrawals are quote-bound intents.",
  "/withdraw address creation happens only after final user confirmation, never during quote preview.",
  "Withdrawal addresses must never be reused.",
  "Compliance blocks restricted trading/copy/monetization/market access. Withdrawals remain available wherever legally possible.",
  "No bypass/VPN logic.",
  "Internal ledger is reconstructable and is not ultimate source of truth over on-chain/CLOB/bridge state.",
] as const;

export const DepositStatuses = [
  "DRAFT",
  "ASSET_SELECTED",
  "ADDRESS_CREATED",
  "TX_DETECTED",
  "BRIDGE_PENDING",
  "PUSD_CREDITED",
  "RECONCILED",
  "BELOW_MINIMUM",
  "WRONG_CHAIN_OR_UNSUPPORTED",
  "FAILED",
  "SUPPORT_NEEDED",
] as const;

export type DepositStatus = typeof DepositStatuses[number];

export const WithdrawalStatuses = [
  "DRAFT",
  "QUOTED",
  "USER_CONFIRMED",
  "WITHDRAW_ADDRESS_CREATED",
  "AWAITING_USER_TRANSFER",
  "PUSD_TRANSFER_SIGNED",
  "PUSD_TRANSFER_CONFIRMED",
  "BRIDGE_PENDING",
  "DESTINATION_RECEIVED",
  "RECONCILED",
  "QUOTE_EXPIRED",
  "ROUTE_UNAVAILABLE",
  "LIQUIDITY_EXHAUSTED",
  "FAILED",
  "SUPPORT_NEEDED",
] as const;

export type WithdrawalStatus = typeof WithdrawalStatuses[number];

export const OrderStatuses = [
  "DRAFT",
  "VALIDATED",
  "SIGNED",
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
  "RECONCILED",
] as const;

export type OrderStatus = typeof OrderStatuses[number];

export const CopyLotStatuses = [
  "OPENED",
  "PARTIALLY_CLOSED",
  "CLOSED",
  "REDEEMED",
  "PNL_FINALIZED",
  "ALPHA_FEE_ASSESSED",
  "ALPHA_FEE_PAID",
  "ALPHA_FEE_UNPAID",
  "LOSS_NO_FEE",
] as const;

export type CopyLotStatus = typeof CopyLotStatuses[number];

export interface WithdrawalIntent {
  id: string;
  userId: string;
  agentId: string;
  depositWallet: string;
  sourceAmountPusd: string;
  destinationChain: string;
  destinationToken: string;
  recipientAddress: string;
  quoteId: string;
  quotePayloadHash: string;
  quoteExpiresAt: string;
  minReceived: string;
  estimatedReceived: string;
  fees: Record<string, unknown>;
  slippage: Record<string, unknown>;
  withdrawalAddress?: string;
  pUsdTransferTxHash?: string;
  status: WithdrawalStatus;
  createdAt: string;
  updatedAt: string;
}

export type SourceOfTruthLayer =
  | "ONCHAIN_BALANCES"
  | "POLYMARKET_CLOB"
  | "BRIDGE_STATUS"
  | "INTERNAL_LEDGER"
  | "UI_CACHE";

export const SOURCE_OF_TRUTH_ORDER: SourceOfTruthLayer[] = [
  "ONCHAIN_BALANCES",
  "POLYMARKET_CLOB",
  "BRIDGE_STATUS",
  "INTERNAL_LEDGER",
  "UI_CACHE",
];

export interface Phase0SdkSnapshot {
  maker?: string;
  signer?: string;
  funder: string;
  depositWallet: string;
  signatureType: 3 | "POLY_1271";
  apiKeyAddressBehavior: string;
  ownerSessionSignerBehavior: string;
  builderCode: string;
  signedOrderPayloadHash: string;
}
