do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'agent_builder_drafts',
    'agent_recipes',
    'agent_builder_events'
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

create index if not exists agent_builder_drafts_payload_owner_idx on agent_builder_drafts ((payload->>'ownerWallet')) where payload ? 'ownerWallet';
create index if not exists agent_builder_drafts_payload_agent_type_idx on agent_builder_drafts ((payload->'result'->'agentConfig'->>'agentType')) where payload ? 'result';
create index if not exists agent_builder_drafts_payload_status_idx on agent_builder_drafts ((payload->>'status')) where payload ? 'status';
create index if not exists agent_builder_drafts_payload_source_idx on agent_builder_drafts ((payload->>'source')) where payload ? 'source';
create index if not exists agent_recipes_payload_owner_wallet_idx on agent_recipes ((payload->'config'->>'ownerWallet')) where payload ? 'config';
create index if not exists agent_recipes_payload_agent_type_idx on agent_recipes ((payload->'config'->>'agentType')) where payload ? 'config';
create index if not exists agent_recipes_payload_visibility_idx on agent_recipes ((payload->>'visibility')) where payload ? 'visibility';
create index if not exists agent_recipes_payload_source_idx on agent_recipes ((payload->>'source')) where payload ? 'source';
create index if not exists agent_builder_events_payload_owner_idx on agent_builder_events ((payload->>'ownerWallet')) where payload ? 'ownerWallet';
create index if not exists agent_builder_events_payload_draft_idx on agent_builder_events ((payload->>'draftId')) where payload ? 'draftId';
create index if not exists agent_builder_events_payload_recipe_idx on agent_builder_events ((payload->>'recipeId')) where payload ? 'recipeId';
create index if not exists agent_builder_events_payload_kind_idx on agent_builder_events ((payload->>'kind')) where payload ? 'kind';
