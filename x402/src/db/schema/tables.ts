export const MODULAR_COMMERCE_TABLES = [
  "policy_decisions",
  "policy_audit_events",
  "seller_profiles",
  "seller_reputation_snapshots",
  "seller_policy_strikes",
  "seller_tax_profiles",
  "seller_tax_aggregates",
  "mutable_personal_records",
  "data_subject_requests",
  "market_event_access_logs",
  "policy_rule_changes",
  "denylist_entries",
  "policy_appeals",
  "agent_spend_policies",
  "agent_spend_usage",
  "agent_wallets",
  "paper_agent_accounts",
  "agent_profiles",
  "alpha_monetization_configs",
  "copy_settings",
  "copy_decisions",
  "copied_lots",
  "alpha_fee_accruals",
  "agent_action_ledgers",
  "fee_waterfalls",
  "fee_accruals",
  "settlement_options",
  "economic_attack_events",
  "compute_jobs",
  "compute_proofs",
  "receipts",
  "webhook_delivery_logs",
  "webhook_replay_keys",
  "emergency_pause_state",
  "marketplace_listings",
  "listing_manifest_versions",
  "listing_state_events",
] as const;

export type ModularCommerceTable = typeof MODULAR_COMMERCE_TABLES[number];

export interface DurableRecord<T = unknown> {
  id: string;
  version: number;
  payload: T;
  actorId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface DurableRepository<T> {
  get(id: string): Promise<DurableRecord<T> | undefined>;
  list(): Promise<Array<DurableRecord<T>>>;
  put(id: string, payload: T, options?: { actorId?: string; immutable?: boolean; now?: Date }): Promise<DurableRecord<T>>;
  append(id: string, payload: T, options?: { actorId?: string; now?: Date }): Promise<DurableRecord<T>>;
}
