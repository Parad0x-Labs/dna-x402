create table if not exists tip_withdrawals (
  id text primary key,
  version integer not null default 1,
  owner_wallet text not null references tip_accounts(owner_wallet),
  recipient_wallet text not null,
  amount_atomic numeric(78, 0) not null,
  token_mint text not null,
  status text not null,
  tx_signature text,
  provider_reference text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint tip_withdrawals_amount_positive check (amount_atomic > 0)
);

drop trigger if exists tip_withdrawals_touch_updated_at on tip_withdrawals;
create trigger tip_withdrawals_touch_updated_at
before update on tip_withdrawals
for each row execute function dna_x402_touch_updated_at();

create index if not exists tip_withdrawals_owner_created_idx on tip_withdrawals (owner_wallet, created_at desc);
create index if not exists tip_withdrawals_status_created_idx on tip_withdrawals (status, created_at asc);
create index if not exists tip_withdrawals_processed_idx on tip_withdrawals (processed_at desc) where processed_at is not null;
create unique index if not exists tip_withdrawals_tx_signature_unique on tip_withdrawals (tx_signature) where tx_signature is not null;

