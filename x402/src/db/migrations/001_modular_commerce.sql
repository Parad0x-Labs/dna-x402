create or replace function dna_x402_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  table_name text;
  tables text[] := array[
    'policy_decisions',
    'policy_audit_events',
    'seller_profiles',
    'seller_reputation_snapshots',
    'seller_policy_strikes',
    'seller_tax_profiles',
    'seller_tax_aggregates',
    'mutable_personal_records',
    'data_subject_requests',
    'market_event_access_logs',
    'policy_rule_changes',
    'denylist_entries',
    'policy_appeals',
    'agent_spend_policies',
    'agent_spend_usage',
    'agent_wallets',
    'paper_agent_accounts',
    'agent_profiles',
    'alpha_monetization_configs',
    'copy_settings',
    'copy_decisions',
    'copied_lots',
    'alpha_fee_accruals',
    'agent_action_ledgers',
    'fee_waterfalls',
    'fee_accruals',
    'settlement_options',
    'economic_attack_events',
    'compute_jobs',
    'compute_proofs',
    'receipts',
    'webhook_delivery_logs',
    'webhook_replay_keys',
    'emergency_pause_state',
    'marketplace_listings',
    'listing_manifest_versions',
    'listing_state_events'
  ];
begin
  foreach table_name in array tables loop
    execute format(
      'create table if not exists %I (
        id text primary key,
        version integer not null default 1,
        payload jsonb not null,
        actor_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz
      )',
      table_name
    );
    execute format('create index if not exists %I on %I (created_at)', table_name || '_created_at_idx', table_name);
    execute format('create index if not exists %I on %I (actor_id)', table_name || '_actor_id_idx', table_name);
    execute format('drop trigger if exists %I on %I', table_name || '_touch_updated_at', table_name);
    execute format(
      'create trigger %I before update on %I for each row execute function dna_x402_touch_updated_at()',
      table_name || '_touch_updated_at',
      table_name
    );
  end loop;
end $$;

create index if not exists receipts_payload_receipt_id_idx on receipts ((payload->>'receiptId'));
create unique index if not exists receipts_payload_receipt_hash_unique on receipts ((payload->>'receiptHash')) where payload ? 'receiptHash';
create index if not exists seller_profiles_payload_wallet_idx on seller_profiles ((payload->>'primaryWallet'));
create index if not exists denylist_entries_payload_subject_idx on denylist_entries ((payload->>'subjectType'), (payload->>'subjectValue'));
create unique index if not exists denylist_entries_active_subject_unique on denylist_entries ((payload->>'subjectType'), (payload->>'subjectValue')) where payload->>'status' = 'ACTIVE';
create index if not exists webhook_replay_keys_payload_key_idx on webhook_replay_keys ((payload->>'idempotencyKey'));
create unique index if not exists webhook_replay_keys_payload_key_unique on webhook_replay_keys ((payload->>'idempotencyKey')) where payload ? 'idempotencyKey';
create unique index if not exists listing_manifest_versions_listing_version_unique on listing_manifest_versions ((payload->>'listingId'), (payload->>'version')) where payload ? 'listingId' and payload ? 'version';
create unique index if not exists fee_waterfalls_no_double_charge_unique on fee_waterfalls ((payload->>'noDoubleChargeKey')) where payload ? 'noDoubleChargeKey';
create index if not exists fee_accruals_payload_receipt_idx on fee_accruals ((payload->>'receiptId')) where payload ? 'receiptId';
create index if not exists fee_accruals_payload_recipient_idx on fee_accruals ((payload->>'recipient')) where payload ? 'recipient';
create index if not exists agent_wallets_payload_agent_idx on agent_wallets ((payload->>'agentId')) where payload ? 'agentId';
create index if not exists agent_wallets_payload_owner_wallet_idx on agent_wallets ((payload->>'ownerWallet')) where payload ? 'ownerWallet';
create index if not exists paper_agent_accounts_payload_agent_idx on paper_agent_accounts ((payload->>'agentId')) where payload ? 'agentId';
create index if not exists agent_profiles_payload_agent_idx on agent_profiles ((payload->>'agentId')) where payload ? 'agentId';
create index if not exists alpha_monetization_configs_payload_source_idx on alpha_monetization_configs ((payload->>'sourceAgentId')) where payload ? 'sourceAgentId';
create index if not exists copy_settings_payload_source_idx on copy_settings ((payload->>'sourceAgentId')) where payload ? 'sourceAgentId';
create index if not exists copy_settings_payload_follower_idx on copy_settings ((payload->>'followerAgentId')) where payload ? 'followerAgentId';
create index if not exists copy_settings_payload_settings_idx on copy_settings ((payload->>'copySettingsId')) where payload ? 'copySettingsId';
create index if not exists copy_decisions_payload_settings_idx on copy_decisions ((payload->>'copySettingsId')) where payload ? 'copySettingsId';
create index if not exists copy_decisions_payload_source_idx on copy_decisions ((payload->>'sourceAgentId')) where payload ? 'sourceAgentId';
create index if not exists copy_decisions_payload_follower_idx on copy_decisions ((payload->>'followerAgentId')) where payload ? 'followerAgentId';
create index if not exists copied_lots_payload_lot_idx on copied_lots ((payload->>'copiedLotId')) where payload ? 'copiedLotId';
create index if not exists copied_lots_payload_settings_idx on copied_lots ((payload->>'copySettingsId')) where payload ? 'copySettingsId';
create index if not exists copied_lots_payload_source_idx on copied_lots ((payload->>'sourceAgentId')) where payload ? 'sourceAgentId';
create index if not exists copied_lots_payload_follower_idx on copied_lots ((payload->>'followerAgentId')) where payload ? 'followerAgentId';
create index if not exists copied_lots_payload_status_idx on copied_lots ((payload->>'status')) where payload ? 'status';
create index if not exists alpha_fee_accruals_payload_lot_idx on alpha_fee_accruals ((payload->>'copiedLotId')) where payload ? 'copiedLotId';
create index if not exists alpha_fee_accruals_payload_source_idx on alpha_fee_accruals ((payload->>'sourceAgentId')) where payload ? 'sourceAgentId';
create index if not exists alpha_fee_accruals_payload_follower_idx on alpha_fee_accruals ((payload->>'followerAgentId')) where payload ? 'followerAgentId';
create index if not exists alpha_fee_accruals_payload_status_idx on alpha_fee_accruals ((payload->>'status')) where payload ? 'status';
create index if not exists agent_action_ledgers_payload_agent_idx on agent_action_ledgers ((payload->>'agentId')) where payload ? 'agentId';
create index if not exists agent_action_ledgers_payload_source_idx on agent_action_ledgers ((payload->>'sourceAgentId')) where payload ? 'sourceAgentId';
create index if not exists agent_action_ledgers_payload_follower_idx on agent_action_ledgers ((payload->>'followerAgentId')) where payload ? 'followerAgentId';
create index if not exists agent_action_ledgers_payload_settings_idx on agent_action_ledgers ((payload->>'copySettingsId')) where payload ? 'copySettingsId';
create index if not exists agent_action_ledgers_payload_lot_idx on agent_action_ledgers ((payload->>'copiedLotId')) where payload ? 'copiedLotId';
create index if not exists agent_action_ledgers_payload_status_idx on agent_action_ledgers ((payload->>'status')) where payload ? 'status';
create index if not exists agent_action_ledgers_payload_receipt_idx on agent_action_ledgers ((payload->>'receiptId')) where payload ? 'receiptId';
