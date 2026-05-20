create table if not exists tip_accounts (
  owner_wallet text primary key,
  version integer not null default 1,
  token_mint text not null,
  balance_atomic numeric(78, 0) not null default 0,
  pending_withdrawal_atomic numeric(78, 0) not null default 0,
  total_deposited_atomic numeric(78, 0) not null default 0,
  total_sent_atomic numeric(78, 0) not null default 0,
  total_received_atomic numeric(78, 0) not null default 0,
  total_withdrawn_atomic numeric(78, 0) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tip_accounts_non_negative check (
    balance_atomic >= 0
    and pending_withdrawal_atomic >= 0
    and total_deposited_atomic >= 0
    and total_sent_atomic >= 0
    and total_received_atomic >= 0
    and total_withdrawn_atomic >= 0
  )
);

drop trigger if exists tip_accounts_touch_updated_at on tip_accounts;
create trigger tip_accounts_touch_updated_at
before update on tip_accounts
for each row execute function dna_x402_touch_updated_at();

create table if not exists tip_deposit_intents (
  id text primary key,
  owner_wallet text not null references tip_accounts(owner_wallet),
  amount_atomic numeric(78, 0),
  token_mint text not null,
  vault_address text,
  memo text not null,
  status text not null default 'PENDING',
  tx_signature text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tip_deposit_intents_status_check check (status in ('PENDING', 'CONFIRMED', 'EXPIRED')),
  constraint tip_deposit_intents_amount_check check (amount_atomic is null or amount_atomic > 0)
);

drop trigger if exists tip_deposit_intents_touch_updated_at on tip_deposit_intents;
create trigger tip_deposit_intents_touch_updated_at
before update on tip_deposit_intents
for each row execute function dna_x402_touch_updated_at();

create table if not exists tip_ledger (
  id text primary key,
  version integer not null default 1,
  event_type text not null,
  owner_wallet text not null,
  counterparty_wallet text,
  amount_atomic numeric(78, 0) not null default 0,
  token_mint text not null,
  status text not null,
  tx_signature text,
  deposit_intent_id text,
  withdrawal_id text,
  transfer_id text,
  memo text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tip_ledger_amount_check check (amount_atomic >= 0)
);

create table if not exists tip_reconciliations (
  id text primary key,
  liability_atomic numeric(78, 0) not null,
  vault_balance_atomic numeric(78, 0) not null,
  ok boolean not null,
  withdrawals_paused boolean not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tip_reconciliations_non_negative check (liability_atomic >= 0 and vault_balance_atomic >= 0)
);

create table if not exists tip_admin_state (
  id text primary key,
  withdrawals_paused boolean not null default false,
  reason text,
  actor_id text,
  updated_at timestamptz not null default now()
);

create index if not exists tip_accounts_updated_idx on tip_accounts (updated_at);
create index if not exists tip_deposit_intents_owner_idx on tip_deposit_intents (owner_wallet);
create index if not exists tip_deposit_intents_status_idx on tip_deposit_intents (status);
create index if not exists tip_deposit_intents_tx_idx on tip_deposit_intents (tx_signature) where tx_signature is not null;
create index if not exists tip_ledger_owner_created_idx on tip_ledger (owner_wallet, created_at desc);
create index if not exists tip_ledger_event_idx on tip_ledger (event_type);
create index if not exists tip_ledger_counterparty_idx on tip_ledger (counterparty_wallet) where counterparty_wallet is not null;
create index if not exists tip_ledger_deposit_intent_idx on tip_ledger (deposit_intent_id) where deposit_intent_id is not null;
create index if not exists tip_ledger_withdrawal_idx on tip_ledger (withdrawal_id) where withdrawal_id is not null;
create index if not exists tip_ledger_transfer_idx on tip_ledger (transfer_id) where transfer_id is not null;
create unique index if not exists tip_ledger_deposit_tx_unique on tip_ledger (tx_signature) where tx_signature is not null and event_type = 'deposit_confirmed';
create index if not exists tip_reconciliations_created_idx on tip_reconciliations (created_at desc);

