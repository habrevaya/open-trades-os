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

-- Three things happen per table, and the second and third are not cosmetic.
-- Measured effects, from Supabase's own RLS performance guidance:
--
--   indexing the column the policy filters on   171 ms  ->  under 0.1 ms
--   wrapping the function in a subselect        178 s   ->  12 ms
--   restricting the policy with TO authenticated 170 ms ->  under 0.1 ms
--
-- The subselect is the one that looks like a typo and is not. Written bare,
-- app.current_organization_id() is evaluated PER ROW. Wrapped as
-- (select app.current_organization_id()) the planner hoists it into an
-- InitPlan and evaluates it once for the whole query. Same result, four
-- orders of magnitude apart on a large table.

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

    -- Every policy filters on organization_id, so every table needs it indexed.
    -- Without this the policy forces a sequential scan on every query.
    execute format(
      'create index if not exists %I on public.%I (organization_id)',
      t.table_name || '_org_rls_idx', t.table_name);

    execute format('drop policy if exists tenant_isolation on public.%I', t.table_name);
    execute format($p$
      create policy tenant_isolation on public.%I
        to authenticated
        using (organization_id = (select app.current_organization_id()))
        with check (organization_id = (select app.current_organization_id()))
    $p$, t.table_name);
  end loop;
end
$$;

-- The organization row itself is scoped by membership, not organization_id.
alter table public.organization enable row level security;
alter table public.organization force row level security;
drop policy if exists organization_member_access on public.organization;
create policy organization_member_access on public.organization
  to authenticated
  using (id = (select app.current_organization_id()));

-- ---- The layer ABOVE the tenant ----------------------------------------
-- `network` deliberately has no organization_id, so the catalog driven loop
-- above does not cover it. That is not an oversight: it is the one table that
-- spans tenants, and it therefore gets an explicit, narrow policy rather than
-- the generic one.
--
-- A network row is visible only to a member of an organization inside it.
-- Crucially this does NOT widen access to anything owned by those
-- organizations. Cross-organization reads go through network_grant, which IS
-- tenant scoped and therefore covered by the generic policy, and are checked
-- in the application against a named aggregate and written to the audit log.
-- The tenant boundary stays absolute; the network layer only ever describes it.

alter table public.network enable row level security;
alter table public.network force row level security;
drop policy if exists network_member_access on public.network;
create policy network_member_access on public.network
  to authenticated
  using (
    id = (
      select o.network_id
      from public.organization o
      where o.id = (select app.current_organization_id())
    )
  );

-- A user row is visible to that user only. Cross-user reads go through
-- membership joins inside the tenant boundary, never through this table.
alter table public."user" enable row level security;
alter table public."user" force row level security;
drop policy if exists user_self_access on public."user";
create policy user_self_access on public."user"
  to authenticated
  using (id = (select app.current_user_id()));

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

-- =========================================================================
-- COVERAGE ASSERTION
--
-- Fails the migration if any table carrying organization_id ended up without
-- row level security. The loop above should make that impossible, but the
-- failure mode is a silent cross tenant leak, so it gets an assertion rather
-- than trust. A table that is deliberately exempt must be named here, in the
-- open, with a reason.
-- =========================================================================

do $$
declare
  unprotected text;
begin
  select string_agg(c.relname, ', ')
    into unprotected
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
   where n.nspname = 'public'
     and c.relkind = 'r'
     and a.attname = 'organization_id'
     and not a.attisdropped
     and not c.relrowsecurity;

  if unprotected is not null then
    raise exception
      'Tables carry organization_id without row level security: %', unprotected;
  end if;
end
$$;
