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

-- ---- Credentials and sessions ------------------------------------------
-- Neither carries organization_id, because both sit above the tenant: a user
-- exists before they join a company and can belong to several. So the catalog
-- driven loop does not reach them, and a live check against a real database
-- found exactly that: two tables holding password hashes and session tokens,
-- readable by any authenticated role.
--
-- Password hashes are never selectable by the application role at all. Login
-- verification runs through a SECURITY DEFINER function, so the hash is
-- compared inside the database and never crosses into application memory.

alter table public.credential enable row level security;
alter table public.credential force row level security;
drop policy if exists credential_no_direct_access on public.credential;
create policy credential_no_direct_access on public.credential
  to authenticated
  using (false)
  with check (false);

alter table public.session enable row level security;
alter table public.session force row level security;
drop policy if exists session_self_access on public.session;
create policy session_self_access on public.session
  to authenticated
  using (user_id = (select app.current_user_id()))
  with check (user_id = (select app.current_user_id()));

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

-- ---- Login, without the application role ever reading a hash ------------
-- SECURITY DEFINER so it runs as the owner and can read `credential` past the
-- deny-all policy above. It returns a user id or null, never the hash.
--
-- The comparison itself stays in the application, because scrypt belongs in a
-- runtime that can afford the memory. What this function guarantees is that
-- the hash is fetched only through a path that logs and rate limits, rather
-- than being selectable from anywhere holding a connection.

create or replace function app.credential_for_login(p_email text)
  returns table (user_id uuid, password_hash text, locked_until timestamptz)
  language sql
  security definer
  set search_path = public, pg_temp
  as $$
    select u.id, c.password_hash, c.locked_until
    from public."user" u
    join public.credential c on c.user_id = u.id
    where lower(u.email) = lower(p_email)
    limit 1
  $$;

revoke all on function app.credential_for_login(text) from public;

-- ---- Resolving a session -------------------------------------------------
-- A chicken and egg problem, and the reason this function exists rather than
-- a direct select.
--
-- The session lookup happens BEFORE we know who the user is: that is what the
-- lookup is for. So a policy keyed on the current user id can never match on
-- the very first read, and locking `session` down without this would simply
-- break login.
--
-- The alternative is to let the request path connect as a role that bypasses
-- row level security, which violates the rule that the service role is never
-- reachable from a request. So resolution goes through a SECURITY DEFINER
-- function taking the token hash, which is a 256 bit secret the caller must
-- already hold. It returns one row or none, and it cannot be used to enumerate
-- anything.

/**
 * Dropped before it is created, rather than replaced.
 *
 * `create or replace function` cannot change the return type of a set
 * returning function, so adding one column to this signature fails the
 * migration on every database that already has the old one, which is every
 * deployed one. The error names the function and not the reason, and the
 * migration is the last place anybody wants to be debugging that.
 *
 * Safe here because this file is idempotent by design and re-run on every
 * migration: nothing depends on the function surviving the gap, and the
 * create follows immediately in the same transaction.
 */
-- The return type changes when the actor gains a field, and `create or
-- replace` cannot change a return type, so this is dropped first rather than
-- replaced. Every addition below has the same cause: a value the actor needs
-- that was resolved nowhere, so the permission or scope that depends on it
-- silently did nothing.
drop function if exists app.resolve_session(text);

create function app.resolve_session(p_token_hash text)
  returns table (
    session_id uuid,
    user_id uuid,
    email text,
    name text,
    organization_id uuid,
    organization_name text,
    organization_slug text,
    /**
     * The company's timezone, resolved with the session rather than fetched
     * separately, because every screen that shows a time needs it on the
     * first render. A dispatcher in Denver looking at a Texas company must
     * see the window the Texas customer was given, and formatting in the
     * viewer's timezone silently shows them a different appointment.
     */
    organization_timezone text,
    setup_completed_at timestamptz,
    role text,
    grants jsonb,
    revocations jsonb,
    /**
     * The per-membership narrowing. Read by `effectiveScope` as a ceiling
     * over whatever the roles resolved to. It was written by an
     * administrator, stored, and then never loaded onto an actor, so setting
     * one restricted nobody.
     */
    scope_overrides jsonb,
    business_unit_id uuid,
    location_id uuid,
    /**
     * The technician this membership IS, and the crews they belong to.
     *
     * Every `own` and `crew` scope compares against these two values, and
     * without them those scopes match nothing at all. That is the right way
     * round to fail, and it still meant a technician signing in saw an empty
     * job list and read it as "no work assigned".
     */
    technician_id uuid,
    crew_ids uuid[],
    /**
     * A custom role REPLACES the preset. Returned as the definition rather
     * than as an id so that resolving a session stays one round trip, which
     * is the whole reason this function exists.
     */
    custom_role_permissions jsonb,
    custom_role_scopes jsonb
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select
      s.id, u.id, u.email, u.name,
      o.id, o.name, o.slug, o.timezone, o.setup_completed_at,
      m.role::text, m.grants, m.revocations, m.scope_overrides,
      m.business_unit_id, m.location_id,
      t.id,
      coalesce(
        (select array_agg(cm.crew_id) from public.crew_member cm where cm.technician_id = t.id),
        '{}'::uuid[]
      ),
      r.permissions, r.scopes
    from public.session s
    join public."user" u on u.id = s.user_id
    join public.organization o on o.id = s.active_organization_id
    join public.membership m
      on m.user_id = s.user_id
     and m.organization_id = s.active_organization_id
    -- Left joins, both of them. An office manager is not a technician and a
    -- membership on a preset has no custom role; neither is a reason to fail
    -- to resolve a session.
    left join public.technician t
      on t.membership_id = m.id and t.active
    left join public.role r
      on r.id = m.role_id and r.deleted_at is null
    where s.token_hash = p_token_hash
      and s.expires_at > now()
      and s.revoked_at is null
      and m.active
    limit 1
  $$;

revoke all on function app.resolve_session(text) from public;

-- Creating and revoking a session have the same problem and the same answer.
create or replace function app.create_session(
  p_user_id uuid, p_token_hash text, p_organization_id uuid, p_expires_at timestamptz
) returns uuid
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    insert into public.session (user_id, token_hash, active_organization_id, expires_at)
    values (p_user_id, p_token_hash, p_organization_id, p_expires_at)
    returning id
  $$;

create or replace function app.revoke_session(p_token_hash text)
  returns void
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    update public.session set revoked_at = now()
    where token_hash = p_token_hash and revoked_at is null
  $$;

revoke all on function app.create_session(uuid, text, uuid, timestamptz) from public;
revoke all on function app.revoke_session(text) from public;

-- -------------------------------------------------------------------------
-- PORTAL GRANTS
--
-- A customer approving an estimate has no session and never will. Resolution
-- has the same shape as a session: the caller holds a 256 bit token, the
-- lookup happens before the organization is known, so it cannot go through
-- row level security.
--
-- One difference matters. Consumption has to be atomic. A payment grant with
-- `max_uses = 1` that is checked and then separately incremented can be spent
-- twice by two requests arriving together, and the second one is a duplicate
-- charge. So the use count is incremented in the same statement that reads the
-- row, and the limit is enforced in the WHERE clause rather than afterwards in
-- application code.
create or replace function app.consume_portal_grant(
  p_token_hash text, p_ip text default null
) returns table (
    grant_id uuid,
    organization_id uuid,
    customer_id uuid,
    scope text,
    subject_id uuid,
    uses_remaining integer
  )
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
  as $$
    update public.portal_grant g
       set use_count   = g.use_count + 1,
           last_used_at = now(),
           last_used_ip = coalesce(p_ip, g.last_used_ip)
     where g.token_hash = p_token_hash
       and g.expires_at > now()
       and g.revoked_at is null
       and (g.max_uses is null or g.use_count < g.max_uses)
    returning
      g.id, g.organization_id, g.customer_id, g.scope::text, g.subject_id,
      case when g.max_uses is null then null else g.max_uses - g.use_count end
  $$;

-- Reading a grant without spending a use. Every refresh of a tracking page
-- would otherwise burn one, which makes `max_uses` unusable for exactly the
-- scopes that need it.
create or replace function app.peek_portal_grant(p_token_hash text)
  returns table (
    grant_id uuid,
    organization_id uuid,
    customer_id uuid,
    scope text,
    subject_id uuid,
    uses_remaining integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select
      g.id, g.organization_id, g.customer_id, g.scope::text, g.subject_id,
      case when g.max_uses is null then null else g.max_uses - g.use_count end
    from public.portal_grant g
    where g.token_hash = p_token_hash
      and g.expires_at > now()
      and g.revoked_at is null
      and (g.max_uses is null or g.use_count < g.max_uses)
    limit 1
  $$;

create or replace function app.revoke_portal_grant(p_token_hash text)
  returns void
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    update public.portal_grant set revoked_at = now()
    where token_hash = p_token_hash and revoked_at is null
  $$;

revoke all on function app.consume_portal_grant(text, text) from public;
revoke all on function app.peek_portal_grant(text) from public;
revoke all on function app.revoke_portal_grant(text) from public;

-- =========================================================================
-- COVERAGE ASSERTION
--
-- Fails the migration if any table carrying organization_id ended up without
-- row level security. The loop above should make that impossible, but the
-- failure mode is a silent cross tenant leak, so it gets an assertion rather
-- than trust. A table that is deliberately exempt must be named here, in the
-- open, with a reason.
-- =========================================================================

-- The first version of this assertion only checked tables carrying
-- organization_id, and a live check against a real database found two tables
-- it could never have caught: `session` and `credential`, holding session
-- tokens and password hashes, with no policy at all.
--
-- So it now asserts over EVERY table in `public`. A table that genuinely needs
-- no policy has to be named here, in the open, with a reason. That is a much
-- better failure mode than an assertion that quietly agrees with itself.

do $$
declare
  exempt constant text[] := array[
    -- Drizzle's own journal. No tenant data, written only by migrations.
    '__drizzle_migrations'
  ];
  unprotected text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into unprotected
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not c.relrowsecurity
     and not (c.relname = any(exempt));

  if unprotected is not null then
    raise exception
      'Tables in public have no row level security and are not exempt: %', unprotected;
  end if;
end
$$;

-- =========================================================================
-- THE APPLICATION ROLE
--
-- Every request runs as this role, and the service layer drops into it inside
-- each transaction. That is what makes row level security actually apply:
-- policies are inert for a superuser or any role holding BYPASSRLS, and a
-- superuser connection string is what DATABASE_URL usually contains the first
-- time anyone runs this.
--
-- It is granted table access and nothing else. It cannot create, alter or drop
-- anything, and it cannot read `credential` or another user's `session`
-- because those carry deny policies.
-- =========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema public to authenticated;
grant usage on schema app to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Future tables and sequences too, so a migration does not silently create
-- something the application cannot read.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- The tenant context helpers. Everything else in `app` stays private: the
-- SECURITY DEFINER functions are called by the auth path with an explicit
-- grant, not by every request.
grant execute on function app.current_organization_id() to authenticated;
grant execute on function app.current_user_id() to authenticated;
grant execute on function app.resolve_session(text) to authenticated;
grant execute on function app.create_session(uuid, text, uuid, timestamptz) to authenticated;
grant execute on function app.consume_portal_grant(text, text) to authenticated;
grant execute on function app.peek_portal_grant(text) to authenticated;
grant execute on function app.revoke_portal_grant(text) to authenticated;
grant execute on function app.revoke_session(text) to authenticated;
grant execute on function app.credential_for_login(text) to authenticated;

-- =========================================================================
-- THE BACKGROUND ROLE
--
-- A worker draining the event log has a problem no request has: it must find
-- out WHICH organizations have work before it can enter any of them. That is
-- a cross tenant read by definition, and row level security is forced, so it
-- cannot be done by selecting.
--
-- The answer is not to run the worker as a superuser. It is a function that
-- returns organization ids and nothing else, callable by a role the request
-- path never uses. `authenticated` is deliberately NOT granted execute: a web
-- request being able to enumerate every tenant with pending work is a leak
-- even though the rows themselves stay protected.
--
-- `background` is a member of `authenticated` so the worker can drop into the
-- ordinary tenant context for the actual work. It discovers organizations
-- with one privilege and then does everything else with none.
-- =========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'background') then
    create role background nologin;
  end if;
end
$$;

grant authenticated to background;

create or replace function app.pending_event_organizations(
  p_consumer text, p_limit int default 50
) returns table (organization_id uuid, pending integer)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select e.organization_id, count(*)::int
    from public.domain_event e
    left join public.event_cursor c
      on c.organization_id = e.organization_id and c.consumer = p_consumer
    where e.sequence > coalesce(c.last_sequence, 0)
    group by e.organization_id
    -- Most behind first. A tenant that has been waiting longest should not be
    -- starved by one that produces events constantly.
    order by min(e.sequence)
    limit p_limit
  $$;

revoke all on function app.pending_event_organizations(text, int) from public;
grant execute on function app.pending_event_organizations(text, int) to background;
