-- =========================================================================
-- Row Level Security, tenant context, and financial guard rails.
--
-- Applied AFTER the generated table migrations. Numbered high on purpose so
-- drizzle-kit's generated files always sort before it.
--
-- An RLS mistake here is a cross-tenant data leak, which is the one bug class
-- that ends a project like this. Every policy below has a matching assertion
-- in test/rls.sql and CI fails if the counts diverge.
-- =========================================================================

-- ---- Tenant context -----------------------------------------------------
-- Set by withTenant() in src/client.ts at the start of every request
-- transaction. Returns NULL when unset, and a NULL org matches no rows, so
-- the failure mode is "see nothing" rather than "see everything".

create or replace function app.current_organization_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.organization_id', true), '')::uuid $$;

create or replace function app.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---- Apply RLS to every tenant-scoped table -----------------------------
-- Driven off the catalog rather than a hand-maintained list, so a new table
-- with an organization_id column is protected the moment it is created and
-- nobody has to remember to add it.

do $$
declare
  t record;
begin
  for t in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attname = 'organization_id'
      and not a.attisdropped
  loop
    execute format('alter table public.%I enable row level security', t.table_name);
    execute format('alter table public.%I force row level security', t.table_name);

    execute format('drop policy if exists tenant_isolation on public.%I', t.table_name);
    execute format($p$
      create policy tenant_isolation on public.%I
        using (organization_id = app.current_organization_id())
        with check (organization_id = app.current_organization_id())
    $p$, t.table_name);
  end loop;
end
$$;

-- The organization row itself is scoped by membership, not organization_id.
alter table public.organization enable row level security;
alter table public.organization force row level security;
drop policy if exists organization_member_access on public.organization;
create policy organization_member_access on public.organization
  using (id = app.current_organization_id());

-- A user row is visible to that user only. Cross-user reads go through
-- membership joins inside the tenant boundary, never through this table.
alter table public."user" enable row level security;
alter table public."user" force row level security;
drop policy if exists user_self_access on public."user";
create policy user_self_access on public."user"
  using (id = app.current_user_id());

-- ---- Ledger is append only ---------------------------------------------
-- No UPDATE. No DELETE. Ever. A correction is a new reversing entry.
-- Enforced in the database rather than in application code, because
-- application code changes and a trigger does not.

create or replace function app.ledger_is_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception
    'ledger_entry is append only: use a reversing entry (reverses_entry_id) instead of %',
    tg_op;
end
$$;

drop trigger if exists ledger_entry_no_update on public.ledger_entry;
create trigger ledger_entry_no_update
  before update or delete on public.ledger_entry
  for each row execute function app.ledger_is_append_only();

-- ---- A ledger transaction must balance ---------------------------------
-- Deferred to the end of the transaction so a balanced pair can be inserted
-- as two statements. Debits and credits within one transaction_id sum to zero
-- or the whole transaction rolls back.

create or replace function app.ledger_transaction_balances() returns trigger
  language plpgsql as $$
declare
  imbalance numeric(14,4);
begin
  select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)
    into imbalance
    from public.ledger_entry
   where transaction_id = new.transaction_id;

  if imbalance <> 0 then
    raise exception
      'ledger transaction % does not balance: debits minus credits = %',
      new.transaction_id, imbalance;
  end if;
  return null;
end
$$;

drop trigger if exists ledger_entry_balanced on public.ledger_entry;
create constraint trigger ledger_entry_balanced
  after insert on public.ledger_entry
  deferrable initially deferred
  for each row execute function app.ledger_transaction_balances();

-- ---- Search -------------------------------------------------------------
create extension if not exists pg_trgm;

create index if not exists customer_name_trgm_idx
  on public.customer using gin (name gin_trgm_ops);
create index if not exists property_address_trgm_idx
  on public.property using gin (address_line1 gin_trgm_ops);
