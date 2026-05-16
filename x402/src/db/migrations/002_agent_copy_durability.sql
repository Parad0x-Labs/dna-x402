do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'agent_wallets',
    'paper_agent_accounts',
    'agent_profiles',
    'alpha_monetization_configs',
    'copy_settings',
    'copy_decisions',
    'copied_lots',
    'alpha_fee_accruals',
    'agent_action_ledgers'
  ]
  loop
    execute format('create table if not exists %I (
      id text primary key,
      version integer not null default 1,
      payload jsonb not null,
      actor_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )', table_name);
    execute format('drop trigger if exists %I on %I', table_name || '_touch_updated_at', table_name);
    execute format('create trigger %I before update on %I for each row execute function dna_x402_touch_updated_at()', table_name || '_touch_updated_at', table_name);
    execute format('create index if not exists %I on %I using gin (payload)', table_name || '_payload_gin', table_name);
    execute format('create index if not exists %I on %I (created_at)', table_name || '_created_idx', table_name);
  end loop;
end $$;

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
