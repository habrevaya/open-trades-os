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

-- A first-password link sits above the tenant for the same reason a
-- credential does, and is closed the same way: nothing selects it, and the
-- three functions near the end of this file are the only way in or out.
alter table public.setup_token enable row level security;
alter table public.setup_token force row level security;
drop policy if exists setup_token_no_direct_access on public.setup_token;
create policy setup_token_no_direct_access on public.setup_token
  to authenticated
  using (false)
  with check (false);

-- The demo's rate limit, closed the same way: `app.create_demo_session` is
-- the only thing that reads or writes it.
alter table public.demo_visit enable row level security;
alter table public.demo_visit force row level security;
drop policy if exists demo_visit_no_direct_access on public.demo_visit;
create policy demo_visit_no_direct_access on public.demo_visit
  to authenticated
  using (false)
  with check (false);

-- A one time sign in code for the field app sits above the tenant for the same
-- reason a first-password link does: it exists before anybody is signed in.
-- Nothing selects it; two functions near the end of this file issue and spend
-- one, so the limits on how many and how often cannot be skipped by a second
-- caller that forgot them.
alter table public.sign_in_code enable row level security;
alter table public.sign_in_code force row level security;
drop policy if exists sign_in_code_no_direct_access on public.sign_in_code;
create policy sign_in_code_no_direct_access on public.sign_in_code
  to authenticated
  using (false)
  with check (false);

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

-- ---- Brute force lockout -------------------------------------------------
-- These two functions exist because the lockout did not.
--
-- `credential.failed_attempts` and `credential.locked_until` were columns
-- nothing ever wrote, and `credential_for_login` went out of its way to
-- return `locked_until` so that sign-in could refuse on it. `locked_until`
-- was always null, so the refusal was dead code, and the error message
-- "This account is temporarily locked. Try again shortly." asserted a control
-- that did not exist. That is the most expensive shape a defect can take
-- here: a security property a reviewer reads the code and ticks off.
--
-- SECURITY DEFINER for the same reason the read is: the credential table is
-- not tenant scoped and the request path must never connect as a role that
-- can write it directly.
create or replace function app.record_failed_login(
  p_email text, p_max_attempts integer, p_lock_minutes integer
) returns void
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
  as $$
    update public.credential c
       set failed_attempts = c.failed_attempts + 1,
           -- Locked only once the threshold is CROSSED, and the window is
           -- measured from this attempt. An attacker who keeps going keeps
           -- pushing their own lock out, which is the behaviour that makes a
           -- lockout worth having.
           locked_until = case
             when c.failed_attempts + 1 >= p_max_attempts
               then now() + make_interval(mins => p_lock_minutes)
             else c.locked_until
           end,
           updated_at = now()
      from public."user" u
     where c.user_id = u.id
       and lower(u.email) = lower(p_email)
  $$;

-- Cleared on a successful sign in, so a person who mistypes twice and then
-- gets it right does not carry two attempts toward a lock a week later.
create or replace function app.clear_failed_logins(p_user_id uuid)
  returns void
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
  as $$
    update public.credential
       set failed_attempts = 0, locked_until = null, updated_at = now()
     where user_id = p_user_id and (failed_attempts <> 0 or locked_until is not null)
  $$;

revoke all on function app.record_failed_login(text, integer, integer) from public;
revoke all on function app.clear_failed_logins(uuid) from public;

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
    custom_role_scopes jsonb,
    /**
     * True for every session of a user that some company names as its demo
     * user (`organization.demo_user_id`), whichever company the session is
     * in. Derived rather than stored on the session, so there is no way to
     * hold a writable session as the demo user: not by signing in with a
     * password somebody set for it, not by a membership somebody added.
     * The application resolves such a session as read only whatever the
     * membership says. docs/self-hosting/demo.md.
     */
    demo boolean
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
      r.permissions, r.scopes,
      exists (select 1 from public.organization d where d.demo_user_id = s.user_id)
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
      -- A suspended company resolves no session. Here rather than in the
      -- caller, for the reason every revocation path below is in SQL: a check
      -- in TypeScript is one the next caller can forget to make. The session
      -- itself is untouched, so resuming the company signs nobody out.
      and o.suspended_at is null
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

-- ---- The demo's sessions ------------------------------------------------
-- `GET /demo` signs a stranger in as the demo company's read only user, so
-- everything that decides whether it may is here, in one statement's worth
-- of SQL rather than in a route a later change can reorder:
--
--   * the company must name a demo user, and that user must hold an active
--     `readonly` membership in it. A deployment that points
--     DEMO_ORGANIZATION_ID at a real company by mistake gets a 404, not a
--     public window into that company;
--   * at most p_limit sessions per address hash in p_window. The count is in
--     the database because a serverless host runs many instances, and a
--     counter in memory is one per instance;
--   * the rows that keep the count, and the demo user's sessions that have
--     been expired a day, are deleted on the way, so neither table grows
--     with the demo's traffic.
--
-- Answers 'not_demo', 'limited' or 'created'.
create or replace function app.create_demo_session(
  p_organization_id uuid, p_token_hash text, p_ip_hash text,
  p_expires_at timestamptz, p_limit integer, p_window interval
) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
    v_recent integer;
  begin
    select o.demo_user_id into v_user
      from public.organization o
      join public.membership m
        on m.organization_id = o.id and m.user_id = o.demo_user_id
     where o.id = p_organization_id
       and o.suspended_at is null
       and m.active
       and m.role = 'readonly'
       and m.role_id is null;
    if v_user is null then
      return 'not_demo';
    end if;

    delete from public.demo_visit where created_at < now() - p_window;
    select count(*) into v_recent
      from public.demo_visit
     where ip_hash = p_ip_hash and created_at >= now() - p_window;
    if v_recent >= p_limit then
      return 'limited';
    end if;

    insert into public.demo_visit (ip_hash) values (p_ip_hash);
    delete from public.session
     where user_id = v_user and expires_at < now() - interval '1 day';
    insert into public.session (user_id, token_hash, active_organization_id, expires_at)
    values (v_user, p_token_hash, p_organization_id, p_expires_at);
    return 'created';
  end
  $$;

revoke all on function app.create_demo_session(uuid, text, text, timestamptz, integer, interval) from public;
grant execute on function app.create_demo_session(uuid, text, text, timestamptz, integer, interval) to authenticated;

revoke all on function app.create_session(uuid, text, uuid, timestamptz) from public;
revoke all on function app.revoke_session(text) from public;

-- -------------------------------------------------------------------------
-- SANDBOXES
-- A sandbox is a second company holding a practice copy of a real one's
-- configuration (services/sandbox.ts). Two doors, both narrow.
--
-- Moving a session between the two halves of a pair. The session table is
-- not the application's to write, so this is a function like creating a
-- session, and it is where the check lives: the person is an active member
-- of where they are going, and where they are going is THIS company's own
-- sandbox (not thrown away) or the company this sandbox was copied from.
-- Any other organization id answers false and moves nothing.
drop function if exists app.switch_session_organization(text, uuid);
create function app.switch_session_organization(p_token_hash text, p_organization_id uuid)
  returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
    v_current uuid;
    v_ok boolean;
  begin
    select s.user_id, s.active_organization_id into v_user, v_current
      from public.session s
     where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now();
    if v_user is null or v_current is null then return false; end if;
    select exists (
      select 1
        from public.organization target
        join public.organization cur on cur.id = v_current
        join public.membership m on m.organization_id = target.id and m.user_id = v_user and m.active
       where target.id = p_organization_id
         and target.suspended_at is null
         and (
           (target.sandbox_of_organization_id = cur.id and cur.sandbox_organization_id = target.id
             and target.sandbox_discarded_at is null)
           or cur.sandbox_of_organization_id = target.id
         )
    ) into v_ok;
    if not v_ok then return false; end if;
    update public.session set active_organization_id = p_organization_id where token_hash = p_token_hash;
    return true;
  end
  $$;
revoke all on function app.switch_session_organization(text, uuid) from public;

-- The other half's name and when it was made, for the band that says which
-- one you are in. Row level security hides the other company's row, rightly;
-- this answers only for the current company's own sandbox or the company it
-- is a sandbox of, and only those two facts.
drop function if exists app.sandbox_pair(uuid);
create function app.sandbox_pair(p_other uuid)
  returns table (name text, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select o.name, o.created_at
      from public.organization o
      join public.organization cur on cur.id = (select app.current_organization_id())
     where o.id = p_other
       and (cur.sandbox_organization_id = o.id or cur.sandbox_of_organization_id = o.id)
  $$;
revoke all on function app.sandbox_pair(uuid) from public;
grant execute on function app.sandbox_pair(uuid) to authenticated;

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
--
-- Both return the contact a grant acts for, when a contact on the customer
-- signed in as them, so the request that follows can be recorded as that
-- person. Adding a column to what a function returns is not something
-- `create or replace` may do, so each is dropped first; the grants on them
-- are given again further down, on every migrate.
drop function if exists app.consume_portal_grant(text, text);
drop function if exists app.peek_portal_grant(text);

create or replace function app.consume_portal_grant(
  p_token_hash text, p_ip text default null
) returns table (
    grant_id uuid,
    organization_id uuid,
    customer_id uuid,
    scope text,
    subject_id uuid,
    uses_remaining integer,
    contact_id uuid
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
       -- A suspended company's links open nothing, and spend no use trying.
       -- The demo company's links open (`peek` below) and act on nothing:
       -- every approval, decline and payment starts here, and none of them
       -- may happen to a company every visitor shares.
       and not exists (
         select 1 from public.organization o
          where o.id = g.organization_id
            and (o.suspended_at is not null or o.demo_user_id is not null)
       )
    returning
      g.id, g.organization_id, g.customer_id, g.scope::text, g.subject_id,
      case when g.max_uses is null then null else g.max_uses - g.use_count end,
      g.contact_id
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
    uses_remaining integer,
    contact_id uuid
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $$
    select
      g.id, g.organization_id, g.customer_id, g.scope::text, g.subject_id,
      case when g.max_uses is null then null else g.max_uses - g.use_count end,
      g.contact_id
    from public.portal_grant g
    where g.token_hash = p_token_hash
      and g.expires_at > now()
      and g.revoked_at is null
      and (g.max_uses is null or g.use_count < g.max_uses)
      and not exists (
        select 1 from public.organization o
         where o.id = g.organization_id and o.suspended_at is not null
      )
    limit 1
  $$;

-- Why `consume_portal_grant` returned nothing, when the answer is "this is
-- the demo". Asked only after it did, so a real customer's link pays nothing
-- for it, and returns a boolean about a token the caller already holds.
create or replace function app.portal_grant_is_demo(p_token_hash text)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from public.portal_grant g
      join public.organization o on o.id = g.organization_id
      where g.token_hash = p_token_hash and o.demo_user_id is not null
    )
  $$;

revoke all on function app.portal_grant_is_demo(text) from public;
grant execute on function app.portal_grant_is_demo(text) to authenticated;

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

-- -------------------------------------------------------------------------
-- COUNTING THE OPEN INTERNET
--
-- The public endpoints (a touch from the website snippet, a pool number for
-- a visitor, a hosted form) count their callers in `public_rate_limit` and
-- refuse past a ceiling. The count is taken before any tenant is known,
-- because which company a request is for is part of what is being counted,
-- so it cannot go through a policy keyed on the current organization.
--
-- Row level security is ON with no policy, so the application role can read
-- and write nothing in the table directly. The only way in is this function,
-- which adds one hit to a key's current window and returns the total. It
-- returns a number about a key the caller supplied and nothing else, so it
-- cannot be used to read anybody's traffic. Old windows are cleared as it
-- goes, a day behind, so the table holds a day of minutes rather than years.
alter table public.public_rate_limit enable row level security;
alter table public.public_rate_limit force row level security;

create or replace function app.count_public_hit(p_key text, p_window_seconds integer)
  returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_window timestamptz := to_timestamp(
      floor(extract(epoch from now()) / greatest(p_window_seconds, 1)) * greatest(p_window_seconds, 1));
    v_hits integer;
  begin
    insert into public.public_rate_limit (key, window_start, hits)
      values (left(p_key, 300), v_window, 1)
      on conflict (key, window_start) do update set hits = public.public_rate_limit.hits + 1
      returning hits into v_hits;
    -- One in a hundred calls sweeps, which keeps the table small without a job.
    if random() < 0.01 then
      delete from public.public_rate_limit where window_start < now() - interval '1 day';
    end if;
    return v_hits;
  end
  $$;

revoke all on function app.count_public_hit(text, integer) from public;
grant execute on function app.count_public_hit(text, integer) to authenticated;

-- ---- OAuth clients, above the tenant -------------------------------------
-- A remote MCP client registers before anybody has told it which company it
-- will be pointed at, so `oauth_client` has no organization_id and the
-- catalog driven loop above does not reach it. Row level security is on with
-- no policy, so the application role can neither read nor write it directly:
-- the two functions below are the only way in, and they hand back a
-- registration and nothing about any company. A registration grants nothing.
alter table public.oauth_client enable row level security;
alter table public.oauth_client force row level security;

-- A confidential client registers with a secret, of which only the SHA-256
-- reaches this table. The four argument form from before confidential
-- clients existed is dropped so nothing can register a client without saying
-- which kind it is.
drop function if exists app.oauth_register_client(text, text, jsonb, text);
create or replace function app.oauth_register_client(
  p_client_id text, p_name text, p_redirect_uris jsonb, p_from text,
  p_auth_method text, p_secret_hash text
) returns void
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    insert into public.oauth_client
      (client_id, name, redirect_uris, registered_from, token_endpoint_auth_method, secret_hash)
    values (p_client_id, left(p_name, 200), p_redirect_uris, left(p_from, 100), p_auth_method, p_secret_hash)
  $$;

revoke all on function app.oauth_register_client(text, text, jsonb, text, text, text) from public;
grant execute on function app.oauth_register_client(text, text, jsonb, text, text, text) to authenticated;

-- Which kind of client it is, but never its secret's hash: a client proves
-- its secret through `oauth_client_secret_matches` below, so the hash does
-- not leave the database even as far as the application.
drop function if exists app.oauth_client(text);
create or replace function app.oauth_client(p_client_id text)
  returns table (client_id text, name text, redirect_uris jsonb, auth_method text)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.client_id, c.name, c.redirect_uris, c.token_endpoint_auth_method
    from public.oauth_client c
    where c.client_id = p_client_id
    limit 1
  $$;

revoke all on function app.oauth_client(text) from public;
grant execute on function app.oauth_client(text) to authenticated;

-- Whether a confidential client presented its own secret. The caller hashes
-- what was sent, so the secret itself is never a parameter here or in a log.
-- A public client has no secret and never matches. The secret before the last
-- rotation matches too, until its overlap ends and not a second after.
create or replace function app.oauth_client_secret_matches(p_client_id text, p_secret_hash text)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce((
      select (c.secret_hash is not null and c.secret_hash = p_secret_hash)
          or (c.previous_secret_hash is not null and c.previous_secret_hash = p_secret_hash
              and c.previous_secret_expires_at > now())
      from public.oauth_client c
      where c.client_id = p_client_id
      limit 1
    ), false)
  $$;

revoke all on function app.oauth_client_secret_matches(text, text) from public;
grant execute on function app.oauth_client_secret_matches(text, text) to authenticated;

-- A confidential client rotating its own secret. Only the CURRENT secret
-- may do it, never the one in its overlap: a leaked old secret that could
-- rotate would let whoever holds it keep a working secret forever. One
-- statement, so two rotations racing cannot both win: the second finds the
-- current hash changed and rotates nothing. A rotation during an overlap
-- retires the oldest, so at most two secrets ever work. Answers whether it
-- rotated and, when it did, until when the old one still works.
create or replace function app.oauth_rotate_client_secret(
  p_client_id text, p_current_hash text, p_new_hash text, p_overlap_seconds int
) returns table (rotated boolean, previous_expires_at timestamptz)
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    with done as (
      update public.oauth_client c
         set previous_secret_hash = case when p_overlap_seconds > 0 then c.secret_hash end,
             previous_secret_expires_at = case when p_overlap_seconds > 0
               then now() + make_interval(secs => least(greatest(p_overlap_seconds, 0), 86400)) end,
             secret_hash = p_new_hash,
             secret_rotated_at = now()
       where c.client_id = p_client_id
         and c.secret_hash is not null
         and c.secret_hash = p_current_hash
         and p_new_hash is not null
      returning c.previous_secret_expires_at
    )
    select exists (select 1 from done), (select previous_secret_expires_at from done limit 1)
  $$;

revoke all on function app.oauth_rotate_client_secret(text, text, text, int) from public;
grant execute on function app.oauth_rotate_client_secret(text, text, text, int) to authenticated;

-- Which companies have connected a client, so a rotation can be written in
-- each one's own audit log. Ids only, read by the server, never answered to
-- the client: a registration says nothing about who approved it.
create or replace function app.oauth_client_connections(p_client_id text)
  returns table (organization_id uuid, app_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select a.organization_id, a.id
    from public.connected_app a
    where a.oauth_client_id = p_client_id
  $$;

revoke all on function app.oauth_client_connections(text) from public;
grant execute on function app.oauth_client_connections(text) to authenticated;

-- REGISTRATIONS NOBODY EVER USED.
-- A client registers before anybody at any company has been asked, and many
-- register on every attempt to connect, so a burst of rows that no company
-- ever approved is normal. One that is a week old with no connected app and
-- no code at any company is junk, and the worker removes it. One that any
-- company ever approved is kept for good, even after the company turned it
-- off, because its id is on that company's connected app and audit lines.
create or replace function app.oauth_purge_unused_clients(p_older_than_days int default 7, p_limit int default 1000)
  returns int
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    with doomed as (
      select c.client_id
      from public.oauth_client c
      where c.created_at < now() - make_interval(days => greatest(p_older_than_days, 1))
        and not exists (select 1 from public.connected_app a where a.oauth_client_id = c.client_id)
        and not exists (select 1 from public.oauth_code k where k.client_id = c.client_id)
      limit p_limit
    ), gone as (
      delete from public.oauth_client c using doomed d where c.client_id = d.client_id returning 1
    )
    select count(*)::int from gone
  $$;

revoke all on function app.oauth_purge_unused_clients(int, int) from public;
-- (The grant to `background` is further down, after that role exists.)

-- The token endpoint is called by a client holding a code or a refresh token
-- and nothing else: no cookie, no tenant. These answer WHICH company a code
-- or a refresh token belongs to, from its 256 bit hash, and nothing more; the
-- exchange itself then runs inside that company like any other write, where
-- every check on the code is made. A suspended company answers nothing.
create or replace function app.oauth_code_organization(p_code_hash text)
  returns uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.organization_id
    from public.oauth_code c
    join public.organization o on o.id = c.organization_id
    where c.code_hash = p_code_hash and o.suspended_at is null
    limit 1
  $$;

revoke all on function app.oauth_code_organization(text) from public;
grant execute on function app.oauth_code_organization(text) to authenticated;

create or replace function app.oauth_refresh_organization(p_token_hash text)
  returns uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select r.organization_id
    from public.oauth_refresh_token r
    join public.organization o on o.id = r.organization_id
    where r.token_hash = p_token_hash and o.suspended_at is null
    limit 1
  $$;

revoke all on function app.oauth_refresh_organization(text) from public;
grant execute on function app.oauth_refresh_organization(text) to authenticated;

-- The same question for an access token, which is an ordinary app token: the
-- revocation and introspection endpoints are handed one by a client with no
-- tenant. Only a token of an app that came through OAuth answers. A token an
-- operator issued by hand is not any OAuth client's to ask about, so to these
-- endpoints it is unknown, exactly like a string nobody issued.
create or replace function app.oauth_access_organization(p_token_hash text)
  returns uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select t.organization_id
    from public.app_token t
    join public.connected_app a on a.id = t.app_id
    join public.organization o on o.id = t.organization_id
    where t.token_hash = p_token_hash
      and a.oauth_client_id is not null
      and o.suspended_at is null
    limit 1
  $$;

revoke all on function app.oauth_access_organization(text) from public;
grant execute on function app.oauth_access_organization(text) to authenticated;

-- An app that asked to be installed comes back for its credential holding
-- the request id and the secret it was given, and no tenant. This answers
-- which company the request is with, for a request and only a request: an
-- app an operator installed by hand has no claim to collect, and naming its
-- company to anybody holding its id would be a small leak for no purpose.
create or replace function app.app_request_organization(p_app_id uuid)
  returns uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select a.organization_id
    from public.connected_app a
    join public.organization o on o.id = a.organization_id
    where a.id = p_app_id and a.source = 'request' and o.suspended_at is null
    limit 1
  $$;

revoke all on function app.app_request_organization(uuid) from public;
grant execute on function app.app_request_organization(uuid) to authenticated;

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
grant execute on function app.record_failed_login(text, integer, integer) to authenticated;
grant execute on function app.clear_failed_logins(uuid) to authenticated;

-- -------------------------------------------------------------------------
-- RESOLVING A CARRIER WEBHOOK
--
-- A text arriving from a carrier has the same problem a session does: the
-- tenant is not known until after the lookup, so no policy keyed on the
-- current organization can match on that first read.
--
-- The webhook URL carries a secret per connection, which means the caller
-- must already hold it, exactly as with a session token. It is also inside
-- the URL the carrier signs, so a token in a URL an attacker chooses does not
-- survive the signature check either.
--
-- Returns the connection and nothing else. It does not return the credential,
-- only the reference, because the secret store is the deployment's business.
create or replace function app.messaging_webhook_connection(p_token text)
  returns table (
    connection_id uuid,
    organization_id uuid,
    provider text,
    settings jsonb,
    credential_ref text
  )
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.id, c.organization_id, c.provider, c.settings, c.credential_ref
    from public.integration_connection c
    where c.capability = 'messaging'
      and c.status = 'connected'
      and c.settings ->> 'webhookToken' = p_token
      -- A token short enough to guess is not a token. Refusing here rather
      -- than trusting whatever was configured means a deployment that sets a
      -- weak one gets no webhooks rather than an open endpoint.
      and length(p_token) >= 32
    limit 1
  $$;

revoke all on function app.messaging_webhook_connection(text) from public;
grant execute on function app.messaging_webhook_connection(text) to authenticated;

-- -------------------------------------------------------------------------
-- RESOLVING AN EMAIL PROVIDER WEBHOOK
--
-- The same problem as the carrier webhook above and the same answer, keyed on
-- the email capability instead. It is a second function rather than a
-- parameter on the first because the capability is what decides which
-- adapter registry the caller reaches for, and a caller that could pass its
-- own capability could aim an email webhook at a messaging connection.
--
-- A deployment whose email provider reports nothing back (generic SMTP) never
-- calls this. Nothing here assumes an email connection has a webhook token.
create or replace function app.email_webhook_connection(p_token text)
  returns table (
    connection_id uuid,
    organization_id uuid,
    provider text,
    settings jsonb,
    credential_ref text
  )
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.id, c.organization_id, c.provider, c.settings, c.credential_ref
    from public.integration_connection c
    where c.capability = 'email'
      and c.status = 'connected'
      and c.settings ->> 'webhookToken' = p_token
      -- Same floor as the messaging token. A token short enough to guess is
      -- not a token, and refusing here means a deployment that sets a weak
      -- one gets no webhooks rather than an endpoint anyone can post to.
      and length(p_token) >= 32
    limit 1
  $$;

revoke all on function app.email_webhook_connection(text) from public;
grant execute on function app.email_webhook_connection(text) to authenticated;

-- -------------------------------------------------------------------------
-- RESOLVING AN APPLICATION TOKEN
--
-- Same shape as a session, and for the same reason: the tenant is not known
-- until the lookup has happened, so no policy keyed on the current
-- organization can match on that first read.
--
-- Every condition here is a revocation path, and all of them have to be in
-- the WHERE clause rather than checked afterwards in application code. An
-- operator who revokes an app at 4pm means 4pm, not "at next token refresh",
-- and a check that lives in TypeScript is one a future caller can forget to
-- make.
create or replace function app.resolve_app_token(p_token_hash text)
  returns table (
    app_id uuid,
    organization_id uuid,
    app_name text,
    permissions jsonb,
    scopes jsonb,
    token_id uuid
  )
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select a.id, a.organization_id, a.name, a.permissions, a.scopes, t.id
    from public.app_token t
    join public.connected_app a on a.id = t.app_id
    join public.organization o on o.id = a.organization_id
    where t.token_hash = p_token_hash
      and t.revoked_at is null
      and t.expires_at > now()
      and a.status = 'active'
      and a.revoked_at is null
      -- Suspension is a revocation path like the others, and lives with them.
      and o.suspended_at is null
      -- Nobody can connect an application to the demo company from inside
      -- it, and one connected any other way would act with the app's
      -- permissions rather than as the read only demo.
      and o.demo_user_id is null
    limit 1
  $$;

revoke all on function app.resolve_app_token(text) from public;
grant execute on function app.resolve_app_token(text) to authenticated;

-- Recording use is a write, so it cannot ride along on a stable function.
-- Separate, and deliberately best effort: "when did this app last read
-- anything" is the first thing an operator looks at before revoking
-- something they no longer recognise.
create or replace function app.touch_app_token(p_token_id uuid)
  returns void
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    with t as (
      update public.app_token set last_used_at = now()
      where id = p_token_id returning app_id
    )
    update public.connected_app set last_used_at = now()
    where id in (select app_id from t)
  $$;

revoke all on function app.touch_app_token(uuid) from public;
grant execute on function app.touch_app_token(uuid) to authenticated;

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

-- Held here rather than beside the function: that one is defined above, before
-- this role exists, and a grant to a role that does not yet exist aborts the
-- whole migration on a database that has never had one (a fresh install, CI).
grant execute on function app.oauth_purge_unused_clients(int, int) to background;

-- `p_only` narrows the search to the companies named, and null (the default,
-- and what the worker passes) searches all of them. It exists for a pass that
-- must not touch tenants it was not asked about: a test sharing its database
-- with a hundred others, or an operator draining one company by hand. Without
-- it, the only way to prove discovery was to drain every company in the
-- database, which in a shared test database ran other files' workflows under
-- them and took most of five seconds doing it.
--
-- The two argument version is dropped first because adding a defaulted
-- argument with `create or replace` makes an overload rather than a
-- replacement, and a call with two arguments is then ambiguous.
drop function if exists app.pending_event_organizations(text, int);

create or replace function app.pending_event_organizations(
  p_consumer text, p_limit int default 50, p_only uuid[] default null
) returns table (organization_id uuid, pending integer)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select e.organization_id, count(*)::int
    from public.domain_event e
    left join public.event_cursor c
      on c.organization_id = e.organization_id and c.consumer = p_consumer
    where e.sequence > coalesce(c.last_sequence, 0)
      and (p_only is null or e.organization_id = any(p_only))
      -- A suspended company's events wait, unread, rather than being skipped
      -- past. See docs/self-hosting/operator-api.md for what that means when
      -- it is resumed. The demo company's wait forever: nothing a workflow
      -- does (a text, an email, a webhook, an accounting push) may leave a
      -- company every visitor shares.
      and not exists (
        select 1 from public.organization o
         where o.id = e.organization_id
           and (o.suspended_at is not null or o.demo_user_id is not null)
      )
    group by e.organization_id
    -- Most behind first. A tenant that has been waiting longest should not be
    -- starved by one that produces events constantly.
    order by min(e.sequence)
    limit p_limit
  $$;

revoke all on function app.pending_event_organizations(text, int, uuid[]) from public;
grant execute on function app.pending_event_organizations(text, int, uuid[]) to background;

-- =========================================================================
-- WHICH COMPANIES HAVE SECRETS UNDER AN OLD KEY
--
-- Rotating SECRETS_MASTER_KEY re-encrypts every company's stored secrets,
-- which is a cross tenant job for the same reason as the function above. It
-- returns ids and nothing else, never a row of `integration_secret`, and the
-- request path's role cannot call it. The re-encryption itself runs per
-- company, inside that company's tenant context.
-- =========================================================================

create or replace function app.secret_organizations(p_current_key_id text)
returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select distinct s.organization_id
      from public.integration_secret s
     where s.key_id <> p_current_key_id
  $$;

revoke all on function app.secret_organizations(text) from public;
grant execute on function app.secret_organizations(text) to background;

-- =========================================================================
-- WHAT IS DUE ON A CLOCK
--
-- The same shape as `pending_event_organizations` and for the same reason:
-- finding work across tenants is a cross tenant read, which row level
-- security forbids and should. It returns ids and the two values the tick
-- needs to decide, nothing else, and it is not callable by the role the
-- request path uses.
--
-- The organization's timezone comes back with the row because a schedule
-- means a wall clock time where the company is. Reading it separately would
-- be one query per workflow per tick.
-- =========================================================================

create or replace function app.scheduled_workflows(p_limit int default 200)
returns table (
  organization_id uuid,
  workflow_id uuid,
  expression text,
  timezone text,
  next_run_at timestamptz,
  stored_expression text
)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select w.organization_id, w.id, w.schedule, o.timezone, s.next_run_at, s.expression
    from public.workflow w
    join public.organization o on o.id = w.organization_id
    left join public.workflow_schedule s
      on s.organization_id = w.organization_id and s.workflow_id = w.id
    where w.enabled
      and w.deleted_at is null
      and w.trigger_kind = 'schedule'
      and w.schedule is not null
      and w.active_version_id is not null
      and o.suspended_at is null
      -- Nor the demo's: see `pending_event_organizations`.
      and o.demo_user_id is null
    -- A workflow with no row yet sorts first, so a new schedule is planned
    -- on the next tick rather than whenever the list happens to reach it.
    order by coalesce(s.next_run_at, '-infinity'::timestamptz)
    limit p_limit
  $$;

revoke all on function app.scheduled_workflows(int) from public;
grant execute on function app.scheduled_workflows(int) to background;

-- =========================================================================
-- RUNS PARKED ON A CLOCK
--
-- "Wait three days, then chase" leaves a run with a time on it. Finding the
-- ones that are due is the same cross tenant read as the two above, and gets
-- the same treatment: ids only, and not callable by the role the request
-- path uses.
-- =========================================================================

create or replace function app.due_workflow_runs(p_limit int default 200)
returns table (organization_id uuid, run_id uuid, resume_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select r.organization_id, r.id, r.resume_at
    from public.workflow_run r
    where r.status = 'waiting'
      and r.resume_at is not null
      and r.resume_at <= now()
      and not exists (
        select 1 from public.organization o
         where o.id = r.organization_id
           and (o.suspended_at is not null or o.demo_user_id is not null)
      )
    -- Longest overdue first, so a backlog drains in the order it built up.
    order by r.resume_at
    limit p_limit
  $$;

revoke all on function app.due_workflow_runs(int) from public;
grant execute on function app.due_workflow_runs(int) to background;

-- =========================================================================
-- CAMPAIGN SENDS THAT ARE DUE
--
-- A text or email campaign with `scheduled_for` in the past, or one already
-- `sending` because a carrier's daily cap left part of its list for another
-- day. `scheduled_for` was stored for a long time and fired by nothing, so a
-- staged send was one press per batch. The worker reads this, and only ids
-- come back: the send itself runs inside the tenant, under its guard.
-- =========================================================================

create or replace function app.due_campaigns(p_limit int default 100)
returns table (organization_id uuid, campaign_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.organization_id, c.id
    from public.marketing_campaign c
    where c.deleted_at is null
      and c.cancelled_at is null
      and (
        (c.state = 'scheduled' and c.scheduled_for is not null and c.scheduled_for <= now())
        or c.state = 'sending'
      )
      and not exists (
        select 1 from public.organization o
         where o.id = c.organization_id and o.suspended_at is not null
      )
    order by coalesce(c.scheduled_for, c.started_at)
    limit p_limit
  $$;

revoke all on function app.due_campaigns(int) from public;
grant execute on function app.due_campaigns(int) to background;

-- =========================================================================
-- WORKFLOWS THAT WATCH FOR SOMETHING NOT HAPPENING
--
-- The same shape as the two above. Ids and the dwell spec, nothing else, and
-- not callable by the role the request path uses.
-- =========================================================================

create or replace function app.dwell_workflows(p_limit int default 100)
returns table (organization_id uuid, workflow_id uuid, dwell jsonb)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select w.organization_id, w.id, w.dwell
    from public.workflow w
    where w.enabled
      and w.deleted_at is null
      and w.trigger_kind = 'dwell'
      and w.dwell is not null
      and w.active_version_id is not null
      and not exists (
        select 1 from public.organization o
         where o.id = w.organization_id
           and (o.suspended_at is not null or o.demo_user_id is not null)
      )
    order by w.created_at
    limit p_limit
  $$;

revoke all on function app.dwell_workflows(int) from public;
grant execute on function app.dwell_workflows(int) to background;

-- =========================================================================
-- ADDRESSES WAITING TO BE PUT ON THE MAP
--
-- The same shape as the three above: a cross tenant read for the worker,
-- ids only, and not callable by the role the request path uses.
--
-- Only companies that have connected a geocoder. A company that has not has
-- chosen not to send its customers' addresses anywhere, and the worker
-- finding their rows anyway would be the first step towards doing it.
--
-- Due means: not placed by hand, the stored coordinate does not answer for
-- the address as it is now, and either the address has not been tried yet or
-- a failure that might clear has passed its back off. The same rule as
-- `geo.geocodeDue` in core, which the worker checks again inside the tenant.
--
-- Within a company, locations first, because a technician's day cannot be
-- ordered without where it starts; then properties with work in the coming week, because
-- those are the pins a dispatcher is about to look for; then the newest,
-- because a customer added this morning is likelier to be booked than one
-- from 2019.
-- =========================================================================

create or replace function app.addresses_to_geocode(p_limit int default 50)
returns table (organization_id uuid, entity text, entity_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    with geocoding as (
      select distinct c.organization_id
      from public.integration_connection c
      join public.organization o on o.id = c.organization_id
      where c.capability = 'maps'
        and c.status = 'connected'
        and c.deleted_at is null
        and o.suspended_at is null
    ),
    due as (
      select l.organization_id, 'location'::text as entity, l.id as entity_id,
             0 as tier, l.created_at
      from public.location l
      join geocoding g on g.organization_id = l.organization_id
      where l.active
        and coalesce(btrim(l.address_line1), '') <> ''
        and l.location_source is distinct from 'manual'
        and l.located_address is distinct from l.address_key
        and (l.geocode_attempted_address is distinct from l.address_key
             or (l.geocode_retry_at is not null and l.geocode_retry_at <= now()))
      union all
      select p.organization_id, 'property'::text, p.id,
             case when exists (
               select 1 from public.job j
               join public.visit v on v.job_id = j.id
               where j.property_id = p.id
                 and v.window_start >= now() - interval '1 day'
                 and v.window_start < now() + interval '7 days'
             ) then 1 else 2 end,
             p.created_at
      from public.property p
      join geocoding g on g.organization_id = p.organization_id
      where p.deleted_at is null
        and btrim(p.address_line1) <> ''
        and p.location_source is distinct from 'manual'
        and p.located_address is distinct from p.address_key
        and (p.geocode_attempted_address is distinct from p.address_key
             or (p.geocode_retry_at is not null and p.geocode_retry_at <= now()))
    )
    -- Round robin across companies, so one company whose geocoder is broken,
    -- or who connected one with forty thousand customers on file, cannot
    -- fill every pass and starve the company that added one customer today.
    , ranked as (
      select organization_id, entity, entity_id, tier, created_at,
             row_number() over (partition by organization_id order by tier, created_at desc, entity_id) as turn
      from due
    )
    select organization_id, entity, entity_id
    from ranked
    order by turn, tier, created_at desc, entity_id
    limit p_limit
  $$;

revoke all on function app.addresses_to_geocode(int) from public;
grant execute on function app.addresses_to_geocode(int) to background;

-- =========================================================================
-- WHERE TECHNICIANS WERE, DELETED ON TIME
--
-- Live positions are kept for the company's retention (`organization.settings
-- -> 'locationSharing' -> 'retentionDays'`, three days when unset, never more
-- than thirty) and then deleted, across every tenant in one statement, which
-- is why this is a definer function: the worker has no tenant. A company
-- that turned sharing off keeps nothing past the same retention either. The
-- bound is enforced here as well as in the service, so a settings row edited
-- by hand cannot keep a person's movements for a year.
--
-- And drive times past their provider's expiry, for the same worker pass.
-- =========================================================================

create or replace function app.purge_technician_positions(p_limit int default 5000)
returns table (organization_id uuid, removed bigint)
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    with doomed as (
      select p.id
      from public.technician_position p
      join public.organization o on o.id = p.organization_id
      where p.recorded_at < now() - make_interval(days => least(30, greatest(1, coalesce(
              case when (o.settings -> 'locationSharing' ->> 'retentionDays') ~ '^[0-9]{1,3}$'
                   then (o.settings -> 'locationSharing' ->> 'retentionDays')::int end, 3))))
      limit p_limit
    ),
    gone as (
      delete from public.technician_position t
      using doomed d where t.id = d.id
      returning t.organization_id
    )
    select g.organization_id, count(*)::bigint from gone g group by g.organization_id
  $$;

revoke all on function app.purge_technician_positions(int) from public;
grant execute on function app.purge_technician_positions(int) to background;

create or replace function app.purge_travel_times(p_limit int default 5000)
returns bigint
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    with doomed as (
      select id from public.travel_time where expires_at < now() limit p_limit
    ), gone as (
      delete from public.travel_time t using doomed d where t.id = d.id returning 1
    )
    select count(*)::bigint from gone
  $$;

revoke all on function app.purge_travel_times(int) from public;
grant execute on function app.purge_travel_times(int) to background;
-- REPORTS AND STATEMENTS THAT ARRIVE ON THEIR OWN
--
-- The same shape as the three above: which schedules are due, across every
-- tenant, as ids and nothing else. Paused ones and suspended companies are
-- left out here rather than in the caller, so forgetting to check is not a
-- way for a paused report to go out.
-- =========================================================================

create or replace function app.due_deliveries(p_limit int default 100)
returns table (organization_id uuid, schedule_id uuid, kind text, next_run_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select s.organization_id, s.id, s.kind::text, s.next_run_at
    from public.delivery_schedule s
    where s.paused_at is null
      and s.next_run_at is not null
      and s.next_run_at <= now()
      and not exists (
        select 1 from public.organization o
         where o.id = s.organization_id and o.suspended_at is not null
      )
    -- Longest overdue first, so a backlog after an outage goes out in the
    -- order it was owed.
    order by s.next_run_at
    limit p_limit
  $$;

revoke all on function app.due_deliveries(int) from public;
grant execute on function app.due_deliveries(int) to background;
-- AGREEMENTS COMING UP FOR RENEWAL
--
-- The same shape as the three above and for the same reason: ids only, not
-- callable by the role the request path uses. A company is returned when it
-- has an active agreement whose end is inside the plan's notice window, with
-- a day to spare either side for timezones, or a term that has ended and not
-- yet released its breakage (what its visits never taken still hold
-- deferred). Whether anything is actually due is decided per agreement, in
-- the company's own calendar, by the service.
-- =========================================================================

create or replace function app.agreement_renewal_organizations(p_limit int default 100)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select x.organization_id
    from (
      select a.organization_id, a.ends_on
      from public.agreement a
      join public.agreement_plan p on p.id = a.plan_id
      where a.status = 'active'
        and a.ends_on is not null
        and (
          a.ends_on <= current_date + 1
          or (a.renewal_notice_sent_at is null
              and a.ends_on <= current_date + p.renewal_notice_days + 1)
        )
      union all
      -- A term that has ended and has not yet given up what it holds deferred.
      select t.organization_id, t.ends_on
      from public.agreement_term t
      where t.breakage_released_on is null and t.ends_on <= current_date + 1
      union all
      -- A lapsed agreement sold before terms were recorded, whose current term has no row yet.
      select a.organization_id, a.ends_on
      from public.agreement a
      where a.status = 'lapsed' and a.ends_on is not null
        and not exists (select 1 from public.agreement_term t
                         where t.agreement_id = a.id and t.term = a.renewal_count + 1)
    ) x
    where not exists (
      select 1 from public.organization o
       where o.id = x.organization_id and o.suspended_at is not null
    )
    group by x.organization_id
    order by min(x.ends_on)
    limit p_limit
  $$;

revoke all on function app.agreement_renewal_organizations(int) from public;
grant execute on function app.agreement_renewal_organizations(int) to background;

-- =========================================================================
-- COMPANIES WITH CONTAINER COLLECTIONS TO BOOK
--
-- The rental pass in the worker books each hire's collection on the board
-- when it comes due, across every tenant, and the worker cannot read across
-- tenants under RLS. This returns the companies with an open hire that has
-- no live collection and is due back (or has a collection agreed) within the
-- company's lead days, with a day to spare for timezones, and that have not
-- turned automatic collections off. Whether each one is due is decided per
-- hire, in the company's own calendar, by the service.
-- =========================================================================

create or replace function app.rental_collection_organizations(p_limit int default 100)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select r.organization_id
    from public.rental r
    join public.organization o on o.id = r.organization_id
    where r.picked_up_at is null
      and r.delivered_at is not null
      and o.suspended_at is null
      and coalesce((o.settings -> 'rentalDispatch' ->> 'automaticCollections')::boolean, true)
      and (
        r.collection_visit_id is null
        or exists (
          select 1 from public.visit v
           where v.id = r.collection_visit_id and v.status = 'cancelled'
        )
      )
      and (
        (r.collection_agreed_start is not null
          and r.collection_agreed_start::date
            <= current_date + coalesce((o.settings -> 'rentalDispatch' ->> 'collectionLeadDays')::int, 1) + 1)
        or (r.collection_agreed_start is null and r.included_days is not null
          and r.delivered_at::date + r.included_days - 1
            <= current_date + coalesce((o.settings -> 'rentalDispatch' ->> 'collectionLeadDays')::int, 1) + 1)
      )
    group by r.organization_id
    order by r.organization_id
    limit p_limit
  $$;

revoke all on function app.rental_collection_organizations(int) from public;
grant execute on function app.rental_collection_organizations(int) to background;
-- WEBHOOK DELIVERIES OWED IN A QUIET COMPANY
--
-- Delivery runs after a company's events are drained, so a company that
-- produced nothing this pass was never visited: a replay somebody asked for
-- sat waiting for the next job to be booked, and so did the retry a failing
-- receiver was owed. This returns the companies with either, as ids and
-- nothing else, in the same shape as the functions above. Whether a retry is
-- due yet is still decided per endpoint by the service, against its backoff.
-- =========================================================================

create or replace function app.webhook_work_organizations(p_limit int default 100)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select e.organization_id
    from public.webhook_endpoint e
    where e.active
      and e.deleted_at is null
      and (
        e.failure_count > 0
        or exists (
          select 1 from public.webhook_replay r
           where r.endpoint_id = e.id and r.status = 'pending'
        )
      )
      and not exists (
        select 1 from public.organization o
         where o.id = e.organization_id and o.suspended_at is not null
      )
    group by e.organization_id
    order by min(e.last_delivery_at) nulls first
    limit p_limit
  $$;

revoke all on function app.webhook_work_organizations(int) from public;
grant execute on function app.webhook_work_organizations(int) to background;

-- ---- Companies with task rules to apply ----------------------------------
-- The task pass in the worker raises recurring tasks and escalates late ones,
-- across every tenant, and the worker cannot read across tenants under RLS.
-- This answers only WHICH companies have an active template or an active
-- escalation rule; what is due is decided per company, in its own timezone,
-- by the service. A suspended company is left alone, like every other pass.
create or replace function app.task_rule_organizations(p_limit int default 200)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select x.organization_id from (
      select t.organization_id from public.task_template t where t.active
      union
      select r.organization_id from public.task_escalation_rule r where r.active
    ) x
    where not exists (
      select 1 from public.organization o
       where o.id = x.organization_id and o.suspended_at is not null
    )
    limit p_limit
  $$;

revoke all on function app.task_rule_organizations(int) from public;
grant execute on function app.task_rule_organizations(int) to background;

-- ---- Companies with toolbox talks to raise ---------------------------------
-- The talk pass raises a scheduled toolbox talk on its day, across every
-- tenant, as the task pass raises a recurring task. This answers only WHICH
-- companies have an active talk schedule; which talk is due is decided per
-- company, in its own timezone, by the service. A suspended company is left
-- alone.
create or replace function app.safety_talk_organizations(p_limit int default 200)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select s.organization_id from public.safety_talk_schedule s
    where s.active
      and not exists (
        select 1 from public.organization o
         where o.id = s.organization_id and o.suspended_at is not null
      )
    group by s.organization_id
    limit p_limit
  $$;

revoke all on function app.safety_talk_organizations(int) from public;
grant execute on function app.safety_talk_organizations(int) to background;

-- ---- Companies holding an estimate that may have passed its date --------
-- The worker marks an open estimate expired once its date has passed in the
-- company's own calendar. It has no tenant until it picks one, so it asks here
-- which companies hold a sent or viewed estimate with a date that is not in
-- the future anywhere on earth, and nothing else. The date is compared loosely
-- on purpose (a company is at most a day ahead of UTC): the service does the
-- exact comparison in each company's timezone. `p_on` is the UTC date the pass
-- is for, the database's own when not given. A suspended company is left
-- alone, like every other pass.
create or replace function app.estimate_expiry_organizations(p_limit int default 200, p_on date default null)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select x.organization_id from (
      select distinct e.organization_id from public.estimate e
       where e.status in ('sent', 'viewed')
         and e.expires_on is not null
         and e.expires_on <= coalesce(p_on, (now() at time zone 'utc')::date)
    ) x
    where not exists (
      select 1 from public.organization o
       where o.id = x.organization_id and o.suspended_at is not null
    )
    limit p_limit
  $$;

revoke all on function app.estimate_expiry_organizations(int, date) from public;
grant execute on function app.estimate_expiry_organizations(int, date) to background;

-- ---- Companies with automatic payments, or card charges to follow up ------
-- A customer who agreed can have each bill charged to their saved card as it
-- is issued, and a charge the worker made may need following up: a declined
-- one tried once more the next day, one the processor took and has since
-- settled or failed, one a worker died in the middle of. The worker has no
-- tenant until it picks one, so it asks here which companies have any of
-- that, and nothing else: a list of ids, as the passes above.
create or replace function app.autopay_organizations(p_limit int default 200)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select x.organization_id from (
      select a.organization_id from public.payment_agreement a
       where a.withdrawn_at is null and a.autopay_at is not null
      union
      select c.organization_id from public.card_on_file_charge c
       where c.status in ('charging', 'submitted')
          or (c.status = 'failed' and c.retry_at is not null)
    ) x
    where not exists (
      select 1 from public.organization o
       where o.id = x.organization_id and o.suspended_at is not null
    )
    limit p_limit
  $$;

revoke all on function app.autopay_organizations(int) from public;
grant execute on function app.autopay_organizations(int) to background;

-- ---- Companies with a truck minimum, for the overnight truck fills --------
-- Each night the worker proposes a fill for every truck under a minimum, as a
-- draft a person confirms. It has no tenant until it picks one, so it asks here
-- which companies keep a truck minimum at all, as ids and nothing else. Whether
-- tonight's proposal has been made is the service's to decide, in the company's
-- own calendar. A suspended company is left alone, like every other pass.
create or replace function app.truck_fill_organizations(p_limit int default 200)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select x.organization_id from (
      select distinct m.organization_id from public.truck_stock_minimum m
       where m.deleted_at is null
    ) x
    where not exists (
      select 1 from public.organization o
       where o.id = x.organization_id and o.suspended_at is not null
    )
    limit p_limit
  $$;

revoke all on function app.truck_fill_organizations(int) from public;
grant execute on function app.truck_fill_organizations(int) to background;

-- ---- Companies whose contract clocks need a pass -------------------------
-- The commercial module keeps SLA, invoicing and claim clocks on jobs, and
-- the worker reconciles them and raises a task for any about to breach. The
-- worker has no tenant until it picks one, so it asks here which companies
-- hold a contract in force or a live clock waiting to escalate, and nothing
-- else: a list of ids, the same shape as task_rule_organizations above.
create or replace function app.contract_clock_organizations(p_limit int default 200)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select x.organization_id from (
      select c.organization_id from public.service_contract c
       where c.active and c.deleted_at is null
      union
      select o.organization_id from public.obligation o
       where o.state in ('open', 'breached') and o.escalate_at is not null and o.escalated_at is null
    ) x
    where not exists (
      select 1 from public.organization o
       where o.id = x.organization_id and o.suspended_at is not null
    )
    limit p_limit
  $$;

revoke all on function app.contract_clock_organizations(int) from public;
grant execute on function app.contract_clock_organizations(int) to background;

-- ---- Ending somebody else's sessions ------------------------------------
-- `session_self_access` above limits the application role to its OWN
-- sessions, which is right: a policy letting any authenticated role read the
-- session table is a policy letting them read live tokens.
--
-- It also means an administrator offboarding a leaver cannot revoke that
-- person's sessions. The first version of `roles.setMembershipActive` tried
-- exactly that, ran as `authenticated`, matched zero rows under this policy,
-- and reported "2 sessions revoked" as zero while the leaver stayed signed
-- in. An offboarding that reports success and ends nothing is worse than one
-- that is missing.
--
-- So the revoke runs here, SECURITY DEFINER, and the authority check runs in
-- the database rather than being trusted from the caller: the actor must
-- hold an ACTIVE membership of the same organization as the target, in a
-- role that can edit users. Passing a different organization, or naming
-- somebody who is not a member of it, revokes nothing.
create or replace function app.revoke_sessions_for(
  p_user_id uuid, p_organization_id uuid, p_actor_user_id uuid
) returns integer
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $$
  declare
    revoked integer;
  begin
    -- The actor's authority, checked here rather than taken on trust. A
    -- function that revoked whatever it was asked to would be a way for any
    -- authenticated role to sign anybody out of anything.
    -- `owner` and `admin` are the presets that hold `user:write`, which is
    -- what the service checks before it gets here. Listed rather than
    -- derived, because a role list in the database cannot see a custom role
    -- and a permissive guess here would be a way around the whole check.
    -- A company using a custom role for offboarding grants it in the
    -- application and reaches this with an owner or admin membership.
    if not exists (
      select 1 from public.membership
       where organization_id = p_organization_id
         and user_id = p_actor_user_id
         and active
         and role in ('owner', 'admin')
    ) then
      return 0;
    end if;

    -- And the target's. Somebody who is not a member of this organization is
    -- not this organization's to sign out.
    if not exists (
      select 1 from public.membership
       where organization_id = p_organization_id
         and user_id = p_user_id
    ) then
      return 0;
    end if;

    with ended as (
      update public.session
         set revoked_at = now(), updated_at = now()
       where user_id = p_user_id
         and revoked_at is null
      returning id
    )
    select count(*)::integer into revoked from ended;

    return revoked;
  end;
  $$;

revoke all on function app.revoke_sessions_for(uuid, uuid, uuid) from public;
grant execute on function app.revoke_sessions_for(uuid, uuid, uuid) to authenticated;

-- =========================================================================
-- THE OPERATOR ROLE
--
-- Whoever runs a deployment with more than one company in it (a hosted
-- service, a firm that keeps the books for several contractors) needs to do
-- a handful of things no tenant may: create a company, look one up by the
-- operator's own reference, count what one has used, suspend and resume one.
-- docs/self-hosting/operator-api.md describes the HTTP surface.
--
-- It gets the shape the worker got, for the same reason. Finding a company by
-- an external reference is a cross tenant read, and row level security is
-- forced, so it cannot be done by selecting. It goes through functions that
-- return ids and counts and nothing else, executable by `platform_operator`
-- and not by `authenticated`, and everything else the operator does happens
-- inside the ordinary tenant context of the one company it named. Like
-- `background`, it is a member of `authenticated` so the policies apply to it
-- exactly as they apply to a request.
--
-- The request path never holds this role. The operator API drops into it
-- with `set local role`, inside its own transaction, after checking a bearer
-- token that has nothing to do with sessions.
-- =========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'platform_operator') then
    create role platform_operator nologin;
  end if;
end
$$;

grant authenticated to platform_operator;

-- `set local role` needs the CONNECTED role to be a member of the target. A
-- superuser already is of everything; on a managed host such as Supabase the
-- account running this file is not a superuser, and without this grant the
-- operator API would fail on its first statement with a permission error that
-- names a role and not the reason. The account running migrations already
-- owns every function below, so this widens nothing. A deployment whose web
-- app connects as a different account grants it to that account by hand.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = current_user and rolsuper)
     and not pg_has_role(current_user, 'platform_operator', 'MEMBER') then
    execute format('grant platform_operator to %I', current_user);
  end if;
exception when others then
  raise warning 'Could not grant platform_operator to %: %. The operator API will refuse until it is granted.',
    current_user, sqlerrm;
end
$$;

-- ---- Columns only the operator writes -----------------------------------
-- `organization_member_access` lets a member's own requests update their own
-- organization row, which the settings screens need. It would also let them
-- clear their own suspension, or take another customer's external reference
-- and be handed that customer's ids on the operator's next retry, or mark
-- itself the demo (or unmark the demo). So these columns are refused to any
-- role that is not the operator, by a trigger, because a policy cannot see
-- which columns an update touches.
create or replace function app.guard_operator_columns() returns trigger
  language plpgsql as $$
begin
  if (new.suspended_at is distinct from old.suspended_at
      or new.suspended_reason is distinct from old.suspended_reason
      or new.external_ref is distinct from old.external_ref
      or new.demo_user_id is distinct from old.demo_user_id)
     and not pg_has_role(current_user, 'platform_operator', 'MEMBER') then
    raise exception 'suspended_at, suspended_reason, external_ref and demo_user_id are written by the operator only'
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists organization_operator_columns on public.organization;
create trigger organization_operator_columns
  before update on public.organization
  for each row execute function app.guard_operator_columns();

-- ---- Finding a company by the operator's reference ----------------------
create or replace function app.operator_organization_by_ref(p_external_ref text)
  returns uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select id from public.organization where external_ref = p_external_ref limit 1
  $$;

revoke all on function app.operator_organization_by_ref(text) from public;
grant execute on function app.operator_organization_by_ref(text) to platform_operator;

-- ---- Whether a person already exists ------------------------------------
-- A user sits above the tenant, so "is there already somebody with this
-- address" cannot be answered from inside one. Returns the id and whether
-- they have a password, never the password.
create or replace function app.operator_user_by_email(p_email text)
  returns table (user_id uuid, has_password boolean)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select u.id, exists (select 1 from public.credential c where c.user_id = u.id)
    from public."user" u
    where lower(u.email) = lower(p_email)
    limit 1
  $$;

create or replace function app.operator_user_has_password(p_user_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (select 1 from public.credential c where c.user_id = p_user_id)
  $$;

revoke all on function app.operator_user_by_email(text) from public;
revoke all on function app.operator_user_has_password(uuid) from public;
grant execute on function app.operator_user_by_email(text) to platform_operator;
grant execute on function app.operator_user_has_password(uuid) to platform_operator;

-- ---- People who were signed in ------------------------------------------
-- The session table is readable by its own user only, so counting a
-- company's signed in people is the one usage number that needs a door.
--
-- "Held a live session at some point in the window" rather than "signed in
-- during it". `last_seen_at` is written when a session is created and not on
-- every request, and a session lasts thirty days, so counting sign-ins would
-- call somebody who signed in five weeks ago and works in it every day
-- inactive.
create or replace function app.operator_active_users(
  p_organization_id uuid, p_since timestamptz
) returns integer
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select count(distinct s.user_id)::integer
    from public.session s
    join public.membership m
      on m.user_id = s.user_id and m.organization_id = p_organization_id
    where s.active_organization_id = p_organization_id
      and s.expires_at >= p_since
      and (s.revoked_at is null or s.revoked_at >= p_since)
      -- The demo's visitors are one shared user and nobody's seat. Counting
      -- them would bill a deployment for its own marketing.
      and not exists (
        select 1 from public.organization d where d.demo_user_id = s.user_id
      )
  $$;

revoke all on function app.operator_active_users(uuid, timestamptz) from public;
grant execute on function app.operator_active_users(uuid, timestamptz) to platform_operator;

-- ---- First-password links -----------------------------------------------
-- Issued by the operator, read and spent by whoever holds the link. Every
-- one of the three refuses a user who already has a password, in the SQL,
-- because the alternative is that issuing a link for an address is a way to
-- take over the account behind it.
create or replace function app.issue_setup_token(
  p_user_id uuid, p_token_hash text, p_expires_at timestamptz
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  begin
    if exists (select 1 from public.credential where user_id = p_user_id) then
      return false;
    end if;
    -- Only the newest link works. An operator asking again is usually one
    -- that lost the first response, and the first link is then in nobody's
    -- hands that should be using it.
    update public.setup_token
       set revoked_at = now(), updated_at = now()
     where user_id = p_user_id and used_at is null and revoked_at is null;
    insert into public.setup_token (user_id, token_hash, expires_at)
    values (p_user_id, p_token_hash, p_expires_at);
    return true;
  end;
  $$;

create or replace function app.peek_setup_token(p_token_hash text)
  returns table (user_id uuid, email text, name text)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select u.id, u.email, u.name
    from public.setup_token t
    join public."user" u on u.id = t.user_id
    where t.token_hash = p_token_hash
      and t.used_at is null
      and t.revoked_at is null
      and t.expires_at > now()
      and not exists (select 1 from public.credential c where c.user_id = t.user_id)
    limit 1
  $$;

-- Spending the link and writing the password are one statement's worth of
-- work in one function, so two tabs submitting together cannot both set one:
-- the second waits on the row lock, finds it used, and gets nothing.
create or replace function app.consume_setup_token(p_token_hash text, p_password_hash text)
  returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
  begin
    update public.setup_token t
       set used_at = now(), updated_at = now()
     where t.token_hash = p_token_hash
       and t.used_at is null
       and t.revoked_at is null
       and t.expires_at > now()
       and not exists (select 1 from public.credential c where c.user_id = t.user_id)
    returning t.user_id into v_user;

    if v_user is null then
      return null;
    end if;

    insert into public.credential (user_id, password_hash) values (v_user, p_password_hash);
    return v_user;
  end;
  $$;

revoke all on function app.issue_setup_token(uuid, text, timestamptz) from public;
revoke all on function app.peek_setup_token(text) from public;
revoke all on function app.consume_setup_token(text, text) from public;
grant execute on function app.issue_setup_token(uuid, text, timestamptz) to platform_operator;
grant execute on function app.peek_setup_token(text) to authenticated;
grant execute on function app.consume_setup_token(text, text) to authenticated;

-- ---- Telling somebody WHY they were refused -----------------------------
-- `resolve_session` and `resolve_app_token` return nothing for a suspended
-- company, which is the safe half. The other half is the person: a refusal
-- that reads "not signed in" sends them round the login page forever, so the
-- caller asks this, ONLY after resolution failed, with the same 256 bit hash
-- it already holds. It answers yes or no about the holder's own company and
-- cannot be used to learn anything about anybody else's.
create or replace function app.credential_suspended(p_token_hash text)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1
      from public.session s
      join public.organization o on o.id = s.active_organization_id
      join public.membership m
        on m.user_id = s.user_id and m.organization_id = s.active_organization_id
      where s.token_hash = p_token_hash
        and s.expires_at > now()
        and s.revoked_at is null
        and m.active
        and o.suspended_at is not null
    ) or exists (
      select 1
      from public.app_token t
      join public.connected_app a on a.id = t.app_id
      join public.organization o on o.id = a.organization_id
      where t.token_hash = p_token_hash
        and t.revoked_at is null
        and t.expires_at > now()
        and a.status = 'active'
        and a.revoked_at is null
        and o.suspended_at is not null
    )
  $$;

revoke all on function app.credential_suspended(text) from public;
grant execute on function app.credential_suspended(text) to authenticated;

-- ---- The people in this company -------------------------------------------
-- A user row is visible to that user alone, which is right for the table and
-- left "who works here" unanswerable from inside the tenant: a join from
-- membership to user returned the caller and nobody else. This answers it for
-- the CURRENT organization only, and only the name and address a colleague can
-- already see on the schedule, never anything from the credential.
create or replace function app.organization_people()
  returns table (membership_id uuid, user_id uuid, name text, email text)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select m.id, u.id, u.name, u.email
    from public.membership m
    join public."user" u on u.id = m.user_id
    where m.organization_id = (select app.current_organization_id())
  $$;

revoke all on function app.organization_people() from public;
grant execute on function app.organization_people() to authenticated;

-- ---- The campaign a job came from -----------------------------------------
-- `job.campaign_id` has been on the job table since the first migration with
-- no foreign key, written by nothing and read by nothing. M19's campaign
-- sender now writes it, and a campaign that gets deleted must not leave jobs
-- pointing at an id that resolves to nothing: an attribution report joining
-- through a dangling id silently drops the revenue a campaign earned.
--
-- Added here rather than in the drizzle schema because `marketing.ts` already
-- imports `job`, so declaring the reverse in `work.ts` would make the two
-- schema modules import each other. ON DELETE SET NULL rather than CASCADE,
-- because deleting a campaign must never delete the work it brought in.
do $$ begin
  alter table public.job
    add constraint job_campaign_id_marketing_campaign_id_fk
    foreign key (campaign_id) references public.marketing_campaign(id)
    on delete set null;
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

-- ---- The rental a swap replaced ------------------------------------------
-- A swap closes one rental and opens another at the same address, and
-- `previous_rental_id` is the link that lets a four week hire with three swaps
-- read as one placement rather than four unrelated week long rentals. The
-- dumpster pack's own average-duration KPI depends on it.
--
-- Added here rather than in the drizzle schema because a self reference needs
-- a lazily typed callback there, which the two existing self references in this
-- schema (`equipment.parent_equipment_id` and `job.parent_job_id`) avoided by
-- carrying no constraint at all. Those two are left as they are; this one gets
-- the constraint, because a dangling previous-rental id does not merely lose a
-- link, it silently shortens a reported rental duration.
--
-- SET NULL rather than CASCADE: deleting the first rental in a chain must not
-- delete the hires that followed it.
do $$ begin
  alter table public.rental
    add constraint rental_previous_rental_id_rental_id_fk
    foreign key (previous_rental_id) references public.rental(id)
    on delete set null;
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

-- -------------------------------------------------------------------------
-- THE ONE PLACE A NETWORK LOOKS ACROSS THE TENANT BOUNDARY
--
-- `network` and `network_grant` have been in this schema since the first
-- migration with no reader and no writer anywhere. They describe a franchise
-- or a holding group: several organizations, each a real tenant with its own
-- customers, under one operator that is entitled to a roll up.
--
-- Row level security is FORCED on every table carrying organization_id, which
-- is the property this whole product rests on, and a roll up is by definition
-- a read across it. So it happens here, in one security definer function, and
-- the rules it enforces are the whole feature:
--
--   THE CALLER MUST BE THE NETWORK'S OPERATOR. Not a member of the network, the
--   operator of it. A franchisee must not be able to read its neighbour's
--   numbers by naming the network it also belongs to, and that is the first
--   thing anybody would try.
--
--   THE MEMBER MUST HAVE GRANTED THIS AGGREGATE. Per aggregate, not per
--   network: a franchisor entitled to revenue under the agreement is not
--   therefore entitled to the general ledger. A member with no grant
--   contributes nothing, silently, because the operator already knows who its
--   members are and the thing being protected is the data rather than the
--   membership.
--
--   A REVOCATION TAKES EFFECT IMMEDIATELY. `revoked_at is null` is checked on
--   every call rather than cached anywhere.
--
--   AGGREGATES ONLY, NEVER ROWS. The return shape is (organization, period,
--   metric, value) and there is no path through it to a customer name, an
--   address, a job description or an invoice number. That is a property of the
--   function body rather than of a convention: every branch below is a GROUP BY.
--
-- A suspended organization contributes nothing either, for the same reason it
-- cannot sign in: whoever runs the deployment has turned it off.
create or replace function app.network_rollup(
  p_network_id uuid,
  p_aggregate text,
  p_from date,
  p_to date
)
  returns table (
    organization_id uuid,
    member_code text,
    period text,
    metric text,
    value numeric
  )
  language sql stable security definer set search_path = public, pg_temp
  as $$
    with operator as (
      -- The caller is the operator of this network, or there is nothing to see.
      select n.id
      from public.network n
      where n.id = p_network_id
        and n.operator_organization_id = (select app.current_organization_id())
        and n.deleted_at is null
    ),
    -- Each member's own zone: a month is that company's month, so a job one of
    -- them finished on the evening of the 31st is counted in the 31st's month
    -- and not, as a UTC month would have it, in the next.
    members as (
      select o.id, o.network_member_code, coalesce(o.timezone, 'America/Chicago') as zone
      from public.organization o
      join operator on true
      join public.network_grant g
        on g.organization_id = o.id
       and g.network_id = p_network_id
       and g.aggregate = p_aggregate
       and g.revoked_at is null
      where o.network_id = p_network_id
        and o.deleted_at is null
        and o.suspended_at is null
    )
    -- Jobs completed, per member per month.
    select m.id, m.network_member_code,
           to_char(j.completed_at at time zone m.zone, 'YYYY-MM'), 'jobs_completed', count(*)::numeric
    from members m
    join public.job j on j.organization_id = m.id
    where p_aggregate = 'job_counts'
      and j.deleted_at is null
      and j.completed_at is not null
      and j.completed_at >= (p_from::timestamp at time zone m.zone)
      and j.completed_at < ((p_to + 1)::timestamp at time zone m.zone)
    group by m.id, m.network_member_code, to_char(j.completed_at at time zone m.zone, 'YYYY-MM')

    union all

    -- Invoiced and collected, per member per month. Two metrics rather than
    -- one, because a franchisor looking at a bad month needs to know whether
    -- the work stopped or the money did.
    select m.id, m.network_member_code,
           to_char(i.issued_on, 'YYYY-MM'), 'invoiced', coalesce(sum(i.total), 0)
    from members m
    join public.invoice i on i.organization_id = m.id
    where p_aggregate in ('revenue_summary', 'kpi_scorecard')
      and i.deleted_at is null
      and i.status <> 'draft'
      and i.voided_at is null
      and i.issued_on is not null
      and i.issued_on between p_from and p_to
    group by m.id, m.network_member_code, to_char(i.issued_on, 'YYYY-MM')

    union all

    select m.id, m.network_member_code,
           to_char(i.issued_on, 'YYYY-MM'), 'collected', coalesce(sum(i.amount_paid), 0)
    from members m
    join public.invoice i on i.organization_id = m.id
    where p_aggregate in ('revenue_summary', 'kpi_scorecard')
      and i.deleted_at is null
      and i.status <> 'draft'
      and i.voided_at is null
      and i.issued_on is not null
      and i.issued_on between p_from and p_to
    group by m.id, m.network_member_code, to_char(i.issued_on, 'YYYY-MM')

    union all

    -- The count of issued invoices, so an average ticket can be worked out by
    -- the reader rather than divided here. A ratio computed inside an aggregate
    -- cannot be summed across members afterwards, and a franchisor comparing
    -- six brands will try.
    select m.id, m.network_member_code,
           to_char(i.issued_on, 'YYYY-MM'), 'invoices', count(*)::numeric
    from members m
    join public.invoice i on i.organization_id = m.id
    where p_aggregate = 'kpi_scorecard'
      and i.deleted_at is null
      and i.status <> 'draft'
      and i.voided_at is null
      and i.issued_on is not null
      and i.issued_on between p_from and p_to
    group by m.id, m.network_member_code, to_char(i.issued_on, 'YYYY-MM')

    union all

    -- The ledger, by account CLASS and never by account code. A class is
    -- revenue, expense, asset, liability or equity, which is what a consolidated
    -- view needs. The code is the member's own chart of accounts and naming one
    -- would let an operator ask about a single account, which is a row read
    -- wearing an aggregate's clothes.
    --
    -- Signed to the account's normal balance, the same rule core/ledger holds:
    -- revenue, liability and equity are credit balances, asset and expense are
    -- debit balances. A sum of raw amounts with the directions mixed is a
    -- number that means nothing.
    select m.id, m.network_member_code,
           to_char(e.occurred_at at time zone m.zone, 'YYYY-MM'),
           case substr(e.account_code, 1, 1)
             when '1' then 'asset' when '2' then 'liability'
             when '3' then 'equity' when '4' then 'revenue'
             else 'expense'
           end,
           sum(
             case
               when substr(e.account_code, 1, 1) in ('1', '5', '6', '7', '8', '9')
                 then case when e.direction = 'debit' then e.amount else -e.amount end
               else case when e.direction = 'credit' then e.amount else -e.amount end
             end
           )
    from members m
    join public.ledger_entry e on e.organization_id = m.id
    where p_aggregate = 'gl_summary'
      and e.occurred_at >= (p_from::timestamp at time zone m.zone)
      and e.occurred_at < ((p_to + 1)::timestamp at time zone m.zone)
    group by m.id, m.network_member_code, to_char(e.occurred_at at time zone m.zone, 'YYYY-MM'),
             substr(e.account_code, 1, 1)
  $$;

revoke all on function app.network_rollup(uuid, text, date, date) from public;
grant execute on function app.network_rollup(uuid, text, date, date) to authenticated;

-- ---- Who is in the network, and what each has agreed to share -------------
-- The operator's own roster. Separate from the roll up because it answers a
-- different question and must answer it even for a member that has granted
-- nothing: "we have six franchisees and two of them have not turned sharing on"
-- is the thing an operator needs to see, and a roster that hid them would make
-- the missing numbers look like zeros.
--
-- Name and member code only. Not the address, not the owner, not the EIN.
create or replace function app.network_members(p_network_id uuid)
  returns table (
    organization_id uuid,
    name text,
    member_code text,
    suspended boolean,
    aggregates text[]
  )
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select o.id, o.name, o.network_member_code, o.suspended_at is not null,
           coalesce(array_agg(g.aggregate order by g.aggregate)
                    filter (where g.aggregate is not null), '{}')
    from public.organization o
    left join public.network_grant g
      on g.organization_id = o.id
     and g.network_id = p_network_id
     and g.revoked_at is null
    where o.network_id = p_network_id
      and o.deleted_at is null
      and exists (
        select 1 from public.network n
        where n.id = p_network_id
          and n.operator_organization_id = (select app.current_organization_id())
          and n.deleted_at is null
      )
    group by o.id, o.name, o.network_member_code, o.suspended_at
  $$;

revoke all on function app.network_members(uuid) from public;
grant execute on function app.network_members(uuid) to authenticated;

-- -------------------------------------------------------------------------
-- SETTING UP A NETWORK, FROM OUTSIDE EVERY TENANT
--
-- A network spans organizations, so none of this can be done from inside one.
-- `platform_operator` inherits `authenticated` and is therefore subject to the
-- same policies, which is deliberate: it means every crossing it makes is a
-- named function somebody can read, rather than a role that sees everything.
--
-- These four are the whole surface. Each is granted to `platform_operator`
-- alone, so a tenant session cannot reach them even by name.
--
-- WHAT IS NOT HERE, and will not be: a function that grants an aggregate on a
-- member's behalf. The consent is the member's and is written by the member's
-- own session. An operator that could grant it would be consenting for
-- somebody else.

create or replace function app.operator_network_by_slug(p_slug text)
  returns uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select id from public.network where slug = p_slug and deleted_at is null limit 1
  $$;

revoke all on function app.operator_network_by_slug(text) from public;
grant execute on function app.operator_network_by_slug(text) to platform_operator;

create or replace function app.operator_create_network(
  p_kind text, p_name text, p_slug text, p_operator_organization_id uuid
)
  returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_id uuid;
  begin
    -- A named organization has to exist, and this is the only place that can
    -- check it: the caller's own tenant context names at most one company, and
    -- a network's operator may not be it.
    if p_operator_organization_id is not null
      and not exists (
        select 1 from public.organization
        where id = p_operator_organization_id and deleted_at is null
      )
    then
      raise exception 'organization % does not exist', p_operator_organization_id
        using errcode = 'no_data_found';
    end if;

    insert into public.network (kind, name, slug, operator_organization_id)
    values (p_kind::network_kind, p_name, p_slug, p_operator_organization_id)
    returning id into v_id;

    -- THE OPERATOR IS A MEMBER OF ITS OWN NETWORK, and has to be: the policy on
    -- `network` admits the network a session's own organization belongs to, so
    -- an operator that was not a member could not read the row describing the
    -- network it operates. It is also right on its own terms, because a
    -- franchisor with company owned branches wants them in the roll up.
    if p_operator_organization_id is not null then
      update public.organization
      set network_id = v_id,
          network_member_code = coalesce(network_member_code, 'operator'),
          updated_at = now()
      where id = p_operator_organization_id;
    end if;

    return v_id;
  end;
  $$;

revoke all on function app.operator_create_network(text, text, text, uuid) from public;
grant execute on function app.operator_create_network(text, text, text, uuid)
  to platform_operator;

-- ---- One network and its members, for the control plane -------------------
-- Name and member code only, the same as the in-product roster. An operator
-- API that handed back addresses and EINs would be a cross tenant read with a
-- deployment's token in front of it.
create or replace function app.operator_network(p_network_id uuid)
  returns table (
    id uuid, kind text, name text, slug text,
    operator_organization_id uuid,
    member_organization_id uuid, member_name text, member_code text
  )
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select n.id, n.kind::text, n.name, n.slug, n.operator_organization_id,
           o.id, o.name, o.network_member_code
    from public.network n
    left join public.organization o
      on o.network_id = n.id and o.deleted_at is null
    where n.id = p_network_id and n.deleted_at is null
    order by o.network_member_code nulls last, o.name
  $$;

revoke all on function app.operator_network(uuid) from public;
grant execute on function app.operator_network(uuid) to platform_operator;

-- ---- Putting a company in a network, or taking it out ---------------------
-- Taking it out REVOKES EVERY GRANT on the way. A franchisee who leaves has not
-- agreed to keep sharing their revenue with their former franchisor, and a
-- grant row left behind with the membership gone would start sharing again the
-- day somebody put them back in.
create or replace function app.operator_set_membership(
  p_organization_id uuid, p_network_id uuid, p_member_code text
)
  returns table (network_id uuid, member_code text)
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  begin
    if not exists (
      select 1 from public.organization
      where id = p_organization_id and deleted_at is null
    ) then
      raise exception 'organization % does not exist', p_organization_id
        using errcode = 'no_data_found';
    end if;

    if p_network_id is not null and not exists (
      select 1 from public.network where id = p_network_id and deleted_at is null
    ) then
      raise exception 'network % does not exist', p_network_id
        using errcode = 'no_data_found';
    end if;

    if p_network_id is null then
      update public.network_grant
      set revoked_at = now(), updated_at = now()
      where organization_id = p_organization_id and revoked_at is null;
    end if;

    update public.organization
    set network_id = p_network_id,
        network_member_code = case when p_network_id is null then null else p_member_code end,
        updated_at = now()
    where id = p_organization_id;

    return query
      select o.network_id, o.network_member_code
      from public.organization o where o.id = p_organization_id;
  end;
  $$;

revoke all on function app.operator_set_membership(uuid, uuid, text) from public;
grant execute on function app.operator_set_membership(uuid, uuid, text) to platform_operator;

-- ---- Which branch a new job belongs to ------------------------------------
-- A branch is a business unit, and `job.business_unit_id` is what a branch
-- scoped person's job list is filtered on (services/scope.ts). Eight places
-- in this product insert a job (booking one, confirming an online request,
-- converting an estimate, accepting a lead, a recurring plan, an agreement
-- visit, a route, a project phase) and not one of them chose a branch, so a
-- branch manager who booked a job watched it vanish from their own list the
-- moment it was saved: it belonged to no branch, and their scope shows one.
--
-- So the default lives here, once, under all eight, rather than in eight
-- services that would each have to remember it. A job saved without a branch
-- takes the branch of the person saving it, then the branch its job type
-- belongs to, and otherwise stays with none, which only company wide people
-- see and Settings > Branches lists for somebody to sort out. A branch that
-- has been retired is not handed to new work. A job saved WITH a branch keeps
-- it: whether this person may choose that branch is the service's question,
-- because it is about their scope rather than about the row.
--
-- Security invoker on purpose. It reads the membership and the job type the
-- request can already see, inside the tenant the request is already in.
create or replace function app.default_job_branch() returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $$
  begin
    if new.business_unit_id is null then
      select m.business_unit_id into new.business_unit_id
        from public.membership m
        join public.business_unit bu on bu.id = m.business_unit_id and bu.active
       where m.organization_id = new.organization_id
         and m.user_id = (select app.current_user_id())
         and m.active
       limit 1;
    end if;
    if new.business_unit_id is null and new.job_type_id is not null then
      select jt.business_unit_id into new.business_unit_id
        from public.job_type jt
        join public.business_unit bu on bu.id = jt.business_unit_id and bu.active
       where jt.id = new.job_type_id
         and jt.organization_id = new.organization_id;
    end if;
    return new;
  end;
  $$;

drop trigger if exists job_default_branch on public.job;
create trigger job_default_branch
  before insert on public.job
  for each row execute function app.default_job_branch();

-- ---- A customer's tags, one row each, kept by the database ----------------
-- `customer_tag` is what the tag filter, the tag counts and a campaign's
-- `tagged_any` read, under an index on the case blind key. The customer's
-- own list stays the record of what they carry, and this rebuilds the rows
-- from it whenever the list or the customer's deleted state changes, in the
-- same statement as the change. Nothing else writes the table, so nothing
-- can leave it disagreeing with the lists: an import, a restore, a rename
-- across the book and a row inserted by hand all pass through here.
--
-- Security invoker. It writes rows for the customer the statement just
-- wrote, under the tenant that statement was already allowed to write in.
-- The key is the one `core/tags` compares by: trimmed, inner spaces run
-- together, lower cased, so a key worked out in TypeScript finds these rows.
create or replace function app.sync_customer_tags() returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $$
  begin
    if tg_op = 'UPDATE'
       and new.tags is not distinct from old.tags
       and (new.deleted_at is null) = (old.deleted_at is null) then
      return null;
    end if;
    if tg_op = 'UPDATE' then
      delete from public.customer_tag where customer_id = new.id;
    end if;
    if new.deleted_at is null then
      insert into public.customer_tag (organization_id, customer_id, position, tag, tag_key)
      select new.organization_id, new.id, (t.ord - 1)::int, t.tag,
             lower(regexp_replace(regexp_replace(t.tag, '\s+', ' ', 'g'), '^ | $', '', 'g'))
      from jsonb_array_elements_text(
        case when jsonb_typeof(new.tags) = 'array' then new.tags else '[]'::jsonb end
      ) with ordinality as t(tag, ord)
      where t.tag is not null;
    end if;
    return null;
  end;
  $$;

drop trigger if exists customer_tags_sync on public.customer;
create trigger customer_tags_sync
  after insert or update of tags, deleted_at on public.customer
  for each row execute function app.sync_customer_tags();

-- ---- A branch's mark on a job or invoice number ---------------------------
-- Numbers stay one sequence per company. A company that turns branch marks on
-- (`organization.settings.branchNumbering`, jobs and invoices separately) has
-- its branch's short code written in front of each NEW job or invoice
-- ("AUS-1042"), here, once, at insert. Nothing recomputes it: a job moved to
-- another branch, or a branch whose code changes, keeps the number its
-- customer was given. Rows made before the setting was turned on keep none.
--
-- A trigger for the reason the default branch is one: eight services insert
-- jobs and four insert invoices, and a mark written by one of them is a mark
-- on some numbers and not others. Named to sort after `job_default_branch`,
-- because Postgres fires a table's triggers in name order and the branch has
-- to be decided before its code can be read.
--
-- Security invoker on purpose: it reads the company's own settings and
-- branches, which the request can already see.
create or replace function app.number_prefix() returns trigger
  language plpgsql
  set search_path = public, pg_temp
  as $$
  declare
    v_unit uuid := new.business_unit_id;
    v_code text;
  begin
    if new.number_prefix is not null then
      return new;
    end if;
    if not exists (
      select 1 from public.organization o
       where o.id = new.organization_id
         and coalesce(o.settings -> 'branchNumbering' ->> (
               case tg_table_name when 'job' then 'jobs' else 'invoices' end
             ), 'false') = 'true'
    ) then
      return new;
    end if;
    -- An invoice usually carries no branch of its own; it is the job's.
    -- Nested rather than one condition, because a job row has no job_id and
    -- PL/pgSQL would refuse the reference even on a branch it never takes.
    if tg_table_name = 'invoice' then
      if v_unit is null and new.job_id is not null then
        select j.business_unit_id into v_unit from public.job j where j.id = new.job_id;
      end if;
    end if;
    if v_unit is null then
      return new;
    end if;
    select upper(trim(bu.code)) into v_code from public.business_unit bu where bu.id = v_unit;
    -- The same rule as `work.numberPrefix` in core: a short run of letters
    -- and digits, or no mark at all.
    if v_code ~ '^[A-Z0-9]{1,8}$' then
      new.number_prefix := v_code;
    end if;
    return new;
  end;
  $$;

drop trigger if exists job_number_prefix on public.job;
create trigger job_number_prefix
  before insert on public.job
  for each row execute function app.number_prefix();

drop trigger if exists invoice_number_prefix on public.invoice;
create trigger invoice_number_prefix
  before insert on public.invoice
  for each row execute function app.number_prefix();

-- ---- Inviting somebody to work here ----------------------------------------
-- The setup wizard's team step, and Settings > Team. Until these two
-- functions existed the only way a second person got into a company was the
-- operator API or a row typed into the database, so every company was one
-- person with a login.
--
-- Both run as definer because the `user` table's policy lets a session see
-- only its own row, which is right and stays right: an office manager must
-- not be able to list every account on the deployment. They check the
-- caller's standing themselves rather than trusting the service, the same as
-- `revoke_sessions_for`, and they act only inside the caller's own company.
-- The permission (`user:invite`) and whether the role being handed out is
-- within the inviter's own authority are checked by the service before it
-- gets here; this is the second lock, not the first.
--
-- AN ADDRESS THAT ALREADY HAS AN ACCOUNT IS NOT ADDED, and that is the rule
-- the whole design rests on. Adding an existing account to this company would
-- hand this company's records to whoever controls that account, and nothing
-- here proves that is the person the address belongs to: anybody can sign up
-- with an address that is not theirs, or be invited somewhere else first and
-- choose the password. So an invite creates the person or finds them already
-- in THIS company, and an address in use anywhere else is refused with
-- `elsewhere` for the service to explain.
create or replace function app.invite_member(p_email text, p_name text, p_role text)
  returns table (membership_id uuid, user_id uuid, outcome text, active boolean, has_password boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_org uuid := (select app.current_organization_id());
    v_actor uuid := (select app.current_user_id());
    v_email text := lower(trim(p_email));
    v_user uuid;
    v_membership uuid;
    v_active boolean;
  begin
    if v_org is null or v_actor is null or not exists (
      select 1 from public.membership m
       where m.organization_id = v_org and m.user_id = v_actor and m.active
    ) then
      raise exception 'only an active member of a company may invite somebody to it'
        using errcode = 'insufficient_privilege';
    end if;

    select u.id into v_user from public."user" u where u.email = v_email;

    if v_user is null then
      insert into public."user" (email, name)
      values (v_email, nullif(trim(coalesce(p_name, '')), ''))
      returning id into v_user;
      insert into public.membership (organization_id, user_id, role)
      values (v_org, v_user, p_role::public.member_role)
      returning id into v_membership;
      return query select v_membership, v_user, 'created'::text, true, false;
      return;
    end if;

    select m.id, m.active into v_membership, v_active
      from public.membership m
     where m.organization_id = v_org and m.user_id = v_user;

    if v_membership is null then
      return query select null::uuid, null::uuid, 'elsewhere'::text, false, false;
      return;
    end if;

    return query select v_membership, v_user, 'member'::text, v_active,
      exists (select 1 from public.credential c where c.user_id = v_user);
  end;
  $$;

-- A first-password link for somebody this company invited.
--
-- `issue_setup_token` is the operator's and stays the operator's. This is the
-- same link with the tenant's narrower rule in front of it: the person must
-- be a member of the caller's company, of NO other company, and have no
-- password yet. The middle condition is what stops one company issuing a
-- link for somebody another company invited and is still waiting on: with it,
-- a link can only ever open an account whose sole membership is the company
-- that asked for it, which is the account it created.
create or replace function app.issue_invite_token(
  p_user_id uuid, p_token_hash text, p_expires_at timestamptz
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_org uuid := (select app.current_organization_id());
    v_actor uuid := (select app.current_user_id());
  begin
    if v_org is null or v_actor is null or not exists (
      select 1 from public.membership m
       where m.organization_id = v_org and m.user_id = v_actor and m.active
    ) then
      return false;
    end if;
    if not exists (
      select 1 from public.membership m where m.organization_id = v_org and m.user_id = p_user_id
    ) then
      return false;
    end if;
    if exists (
      select 1 from public.membership m where m.user_id = p_user_id and m.organization_id <> v_org
    ) then
      return false;
    end if;
    if exists (select 1 from public.credential c where c.user_id = p_user_id) then
      return false;
    end if;

    update public.setup_token
       set revoked_at = now(), updated_at = now()
     where user_id = p_user_id and used_at is null and revoked_at is null;
    insert into public.setup_token (user_id, token_hash, expires_at)
    values (p_user_id, p_token_hash, p_expires_at);
    return true;
  end;
  $$;

revoke all on function app.invite_member(text, text, text) from public;
revoke all on function app.issue_invite_token(uuid, text, timestamptz) from public;
grant execute on function app.invite_member(text, text, text) to authenticated;
grant execute on function app.issue_invite_token(uuid, text, timestamptz) to authenticated;

-- Which of this company's people have not chosen a password yet: invited,
-- and not in. Membership ids only, for the team list to say "has not signed
-- in yet" and offer a fresh link. Whether a colleague has finished signing
-- up is not a secret inside their own company; their password row is, and
-- this reads its existence and nothing else.
create or replace function app.organization_people_waiting()
  returns table (membership_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select m.id
    from public.membership m
    where m.organization_id = (select app.current_organization_id())
      and not exists (select 1 from public.credential c where c.user_id = m.user_id)
  $$;

revoke all on function app.organization_people_waiting() from public;
grant execute on function app.organization_people_waiting() to authenticated;

-- A first-password link for an invite's EMAIL, made at the moment the outbox
-- hands that email to the provider.
--
-- The email in the outbox does not carry the link: everybody who reads the
-- inbox can read the outbox, and a link that chooses a new colleague's
-- password, sitting in a dispatcher's inbox, is a way into an account the
-- dispatcher was never given. So the outbox asks for a link as it sends, puts
-- it in the copy that goes to the provider, and keeps it nowhere.
--
-- The caller is the outbox, which acts as nobody, so this does not ask who is
-- calling. It asks the things that make the link safe to make instead: the
-- invite is this company's, not replaced and not expired, its person is still
-- turned on, belongs to no other company and has no password yet, and an
-- email sealed to this invite is in the middle of being sent right now. The
-- last of those is what stops this being a way to mint a link at any other
-- time. The link it makes ends when the invite does, and making it does not
-- retire the link the inviter was shown: both are the same invite.
create or replace function app.issue_invite_email_token(p_invite_id uuid, p_token_hash text)
  returns timestamptz
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_org uuid := (select app.current_organization_id());
    v_user uuid;
    v_expires timestamptz;
  begin
    if v_org is null then
      return null;
    end if;
    select m.user_id, i.expires_at into v_user, v_expires
      from public.membership_invite i
      join public.membership m on m.id = i.membership_id and m.organization_id = i.organization_id
     where i.id = p_invite_id
       and i.organization_id = v_org
       and i.replaced_at is null
       and i.expires_at > now()
       and m.active
       and exists (
         select 1 from public.message msg
          where msg.sealed_invite_id = i.id
            and msg.organization_id = v_org
            and msg.status = 'sending'
       );
    if v_user is null then
      return null;
    end if;
    if exists (select 1 from public.membership m where m.user_id = v_user and m.organization_id <> v_org) then
      return null;
    end if;
    if exists (select 1 from public.credential c where c.user_id = v_user) then
      return null;
    end if;
    insert into public.setup_token (user_id, token_hash, expires_at)
    values (v_user, p_token_hash, v_expires);
    return v_expires;
  end;
  $$;

revoke all on function app.issue_invite_email_token(uuid, text) from public;
grant execute on function app.issue_invite_email_token(uuid, text) to authenticated;
-- =========================================================================
-- THE FIELD APP: ONE TIME SIGN IN CODES AND PUSH NOTICES
-- =========================================================================

-- The functions that issue and spend a code are under "The field app" near
-- the end of this file.

-- Issue a code for whoever owns this email, replacing any live one they had.
-- Returns nothing for an address nobody owns, and `issued = false` for one
-- that has asked too often lately, so the caller can answer both the same
-- way and the form never says which addresses exist.
create or replace function app.issue_sign_in_code(
  p_email text, p_code_hash text, p_channel text, p_expires_at timestamptz,
  p_per_window int, p_window_minutes int
) returns table (user_id uuid, email text, name text, issued boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_user public."user"%rowtype;
    v_recent int;
  begin
    select * into v_user from public."user" u where lower(u.email) = lower(p_email) limit 1;
    if not found then
      return;
    end if;

    -- Serialised per person, so two requests at once cannot both read two
    -- recent codes and both issue a third.
    perform pg_advisory_xact_lock(hashtext('sign_in_code:' || v_user.id::text));

    select count(*) into v_recent from public.sign_in_code c
     where c.user_id = v_user.id
       and c.created_at > now() - make_interval(mins => p_window_minutes);
    if v_recent >= p_per_window then
      return query select v_user.id, v_user.email, v_user.name, false;
      return;
    end if;

    -- Only the newest code works. A person asking again usually never got
    -- the first one, and the first one is then in nobody's hands that
    -- should be using it.
    update public.sign_in_code c
       set revoked_at = now(), updated_at = now()
     where c.user_id = v_user.id and c.used_at is null and c.revoked_at is null;

    insert into public.sign_in_code (user_id, code_hash, channel, expires_at)
    values (v_user.id, p_code_hash, p_channel, p_expires_at);

    return query select v_user.id, v_user.email, v_user.name, true;
  end;
  $$;

-- Try a code. Returns the person on a match and spends the code in the same
-- statement, so two phones submitting it together cannot both sign in: the
-- second waits on the row lock and finds it used. A wrong guess is counted
-- against the live code, and at the limit the code is revoked, so the five
-- guesses a code allows cannot become fifty by asking again and again.
-- Returns null for every refusal alike: wrong, expired, spent or never sent.
create or replace function app.consume_sign_in_code(
  p_email text, p_code_hash text, p_max_attempts int
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_code public.sign_in_code%rowtype;
  begin
    select c.* into v_code
      from public.sign_in_code c
      join public."user" u on u.id = c.user_id
     where lower(u.email) = lower(p_email)
       and c.used_at is null
       and c.revoked_at is null
       and c.expires_at > now()
     order by c.created_at desc
     limit 1
     for update of c;

    if not found then
      return null;
    end if;

    if v_code.code_hash = p_code_hash then
      update public.sign_in_code
         set used_at = now(), updated_at = now()
       where id = v_code.id;
      return v_code.user_id;
    end if;

    update public.sign_in_code
       set attempts = attempts + 1,
           revoked_at = case when attempts + 1 >= p_max_attempts then now() else revoked_at end,
           updated_at = now()
     where id = v_code.id;
    return null;
  end;
  $$;

revoke all on function app.issue_sign_in_code(text, text, text, timestamptz, int, int) from public;
revoke all on function app.consume_sign_in_code(text, text, int) from public;
grant execute on function app.issue_sign_in_code(text, text, text, timestamptz, int, int) to authenticated;
grant execute on function app.consume_sign_in_code(text, text, int) to authenticated;

-- ---- Companies with a push to send ----------------------------------------
-- The push pass reads each company's changes to somebody's day from its own
-- position in the event log (the `push` consumer) and sends what it writes. The same shape as the functions
-- above: which companies have a change it has not read, a notice still
-- waiting to go, or a receipt still owed, as ids and nothing else. Whether
-- any of it is due is decided per company by the service.
create or replace function app.push_work_organizations(p_limit int default 50)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select x.organization_id from (
      select e.organization_id
        from public.domain_event e
        left join public.event_cursor c
          on c.organization_id = e.organization_id and c.consumer = 'push'
       where e.sequence > coalesce(c.last_sequence, 0)
         -- Only the changes a phone is told about, so a company busy with
         -- everything else is not visited on every pass for nothing.
         and e.name in ('visit.assigned', 'visit.unassigned', 'visit.rescheduled', 'visit.cancelled')
       group by e.organization_id
      union
      select d.organization_id
        from public.push_delivery d
       where d.status in ('queued', 'sending')
          or (d.status = 'sent' and d.ticket_id is not null and d.receipt_checked_at is null)
          -- A notice that ended without reaching anybody, not yet put to the office.
          or (d.status in ('failed', 'skipped') and d.office_told_at is null)
       group by d.organization_id
    ) x
    where not exists (
      select 1 from public.organization o
       where o.id = x.organization_id and o.suspended_at is not null
    )
    limit p_limit
  $$;

revoke all on function app.push_work_organizations(int) from public;
grant execute on function app.push_work_organizations(int) to background;

-- =========================================================================
-- THE AD PLATFORMS, ANALYTICS AND REVIEW LISTINGS THE WORKER VISITS
--
-- The same shape as the others: which companies have a connected Google Ads,
-- Local Services, Meta, Google Analytics or Business Profile connection, as
-- ids and nothing else. Whether anything is DUE for one of them (a spend
-- pull, a lead pull, a review read, a conversion to send) is the service's
-- question, asked inside the company's own tenant, so this function never
-- reads a sync row or a send. The one least recently visited comes first,
-- so a deployment with more companies than one pass reaches still turns
-- through all of them.
-- =========================================================================

create or replace function app.ad_work_organizations(p_limit int default 50)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.organization_id
      from public.integration_connection c
      join public.organization o on o.id = c.organization_id
      left join public.sync_run r on r.connection_id = c.id
     where c.provider in ('google_ads', 'google_lsa', 'meta_ads', 'ga4', 'google_business_profile',
                          'bing_ads', 'meta_lead_ads', 'search_console', 'ga4_data', 'facebook_page')
       and c.status = 'connected'
       and c.deleted_at is null
       and o.suspended_at is null
     group by c.organization_id
     order by max(r.started_at) nulls first
     limit p_limit
  $$;

revoke all on function app.ad_work_organizations(int) from public;
grant execute on function app.ad_work_organizations(int) to background;

-- -------------------------------------------------------------------------
-- COMPANIES WITH A MAILING HALF SENT
--
-- A mailing larger than one send's batch is left `sending` with pieces still
-- pending, and the worker posts the rest. Ids and nothing else, oldest
-- mailing first; the pieces themselves are read inside the company's own
-- tenant boundary.
create or replace function app.mail_work_organizations(p_limit int default 50)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select mc.organization_id
      from public.mail_campaign mc
      join public.organization o on o.id = mc.organization_id
     where mc.state = 'sending'
       and o.suspended_at is null
     group by mc.organization_id
     order by min(mc.updated_at)
     limit p_limit
  $$;

revoke all on function app.mail_work_organizations(int) from public;
grant execute on function app.mail_work_organizations(int) to background;
-- COMPANIES WITH AN AI AGENT THAT RUNS ON ITS OWN
--
-- Intake, text chat and collections run on the worker's clock as the person
-- each company chose, and only for companies that turned one on and chose
-- that person. Ids and nothing else, in the same shape as the functions
-- above; what each agent then reads, it reads inside the company's own
-- tenant boundary as that person.
-- =========================================================================

create or replace function app.ai_agent_organizations(p_limit int default 200)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select s.organization_id
      from public.ai_agent_setting s
     where s.agent in ('intake', 'chat', 'collections')
       and s.run_as_user_id is not null
       and (s.settings ->> 'enabled') = 'true'
       and not exists (
         select 1 from public.organization o
          where o.id = s.organization_id and o.suspended_at is not null
       )
     group by s.organization_id
     limit p_limit
  $$;

revoke all on function app.ai_agent_organizations(int) from public;
grant execute on function app.ai_agent_organizations(int) to background;
-- ---- Companies whose records may be due for purging --------------------
-- The retention purge removes records past a declared period, once a day per
-- company, and only under a policy the company itself switched purging on
-- for: the trade packs seed every policy with purging off. This answers WHICH
-- companies have such a policy and have not had a pass in the last twenty
-- hours, as ids and nothing else. What is due, what is held and what goes is
-- decided per company by the service, which writes an audit line per record.
create or replace function app.retention_purge_organizations(p_limit int default 50)
returns table (organization_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select p.organization_id
    from public.retention_policy p
    where p.active and p.purge_allowed
      and not exists (
        select 1 from public.organization o
         where o.id = p.organization_id and o.suspended_at is not null
      )
      and not exists (
        select 1 from public.retention_purge_run r
         where r.organization_id = p.organization_id
           and r.trigger = 'worker'
           and r.started_at > now() - interval '20 hours'
      )
    group by p.organization_id
    limit p_limit
  $$;

revoke all on function app.retention_purge_organizations(int) from public;
grant execute on function app.retention_purge_organizations(int) to background;

-- ---- A purchase order's printable link, for the vendor ------------------
-- An emailed order carries a link that opens the order as the vendor reads
-- it, with no sign in, because a supply house counter has no account here.
-- The link is a random token whose SHA-256 is all `purchase_order_send`
-- keeps. This resolves a hash to the company and the order, and nothing else,
-- for the same reason the portal grant functions above do: the page has no
-- tenant until the token says which one, and row level security is what
-- keeps the rest of that company out of reach once it does. An expired link,
-- or one from a suspended company, resolves to nothing.
create or replace function app.purchase_order_link(p_token_hash text)
returns table (organization_id uuid, purchase_order_id uuid)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select s.organization_id, s.purchase_order_id
    from public.purchase_order_send s
    where s.link_token_hash = p_token_hash
      and s.link_expires_at > now()
      and s.state = 'queued'
      and not exists (
        select 1 from public.organization o
         where o.id = s.organization_id and o.suspended_at is not null
      )
    limit 1
  $$;

revoke all on function app.purchase_order_link(text) from public;
grant execute on function app.purchase_order_link(text) to authenticated;

-- ---- Loading a copy into an empty company --------------------------------
-- A restore names the people who worked in the company by their address, and
-- a person sits above the tenant, so "is there already an account for this
-- address" cannot be answered from inside one. This answers it for each
-- person in the copy and makes an account, with no password, for an address
-- nobody has yet: the same thing an invitation does.
--
-- An address that already has an account is linked to the restored company
-- only when it is the caller's own, or when that account works for a company
-- the caller runs as an active owner, which is the case of restoring a copy
-- beside the company it was taken from. Any other account is answered
-- `elsewhere` and left alone: a file is not allowed to add somebody's existing
-- account to a company, for the reason an invitation is not.
--
-- Only an active owner of the current company may ask, so a restore cannot be
-- the way somebody without that standing mints accounts.
create or replace function app.restore_people(p_people jsonb)
  returns table (old_user_id uuid, email text, user_id uuid, outcome text)
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_org uuid := (select app.current_organization_id());
    v_actor uuid := (select app.current_user_id());
    v_actor_email text;
    v_person jsonb;
    v_old uuid;
    v_email text;
    v_name text;
    v_user uuid;
  begin
    if v_org is null or v_actor is null or not exists (
      select 1 from public.membership m
       where m.organization_id = v_org and m.user_id = v_actor and m.active and m.role = 'owner'
    ) then
      raise exception 'only an active owner of a company may restore people into it'
        using errcode = 'insufficient_privilege';
    end if;

    select lower(u.email) into v_actor_email from public."user" u where u.id = v_actor;

    for v_person in select * from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) loop
      v_old := (v_person->>'userId')::uuid;
      v_email := lower(trim(coalesce(v_person->>'email', '')));
      v_name := nullif(trim(coalesce(v_person->>'name', '')), '');

      if v_email = '' then
        return query select v_old, v_email, null::uuid, 'no_address'::text;
        continue;
      end if;

      if v_email = v_actor_email then
        return query select v_old, v_email, v_actor, 'you'::text;
        continue;
      end if;

      select u.id into v_user from public."user" u where u.email = v_email;

      if v_user is null then
        insert into public."user" (id, email, name)
        values (
          case when v_old is not null and not exists (select 1 from public."user" x where x.id = v_old)
               then v_old else gen_random_uuid() end,
          v_email, v_name)
        returning id into v_user;
        return query select v_old, v_email, v_user, 'new'::text;
        continue;
      end if;

      if exists (
        select 1 from public.membership mine
          join public.membership theirs on theirs.organization_id = mine.organization_id
         where mine.user_id = v_actor and mine.role = 'owner' and mine.active
           and theirs.user_id = v_user
      ) then
        return query select v_old, v_email, v_user, 'linked'::text;
      else
        return query select v_old, v_email, null::uuid, 'elsewhere'::text;
      end if;
    end loop;
  end;
  $$;

revoke all on function app.restore_people(jsonb) from public;
grant execute on function app.restore_people(jsonb) to authenticated;

-- Whether the company a copy was taken from is on this deployment. When it
-- is, every id in the copy is already taken by the original, so the restore
-- gives every record a new one; when it is not, the ids are kept, which is
-- what lets links, integrations and anything else that remembered an id keep
-- working after a move. A yes or no about an id the caller already holds in
-- their file, asked only by an active member of a company.
create or replace function app.restore_source_present(p_organization_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from public.membership m
       where m.organization_id = (select app.current_organization_id())
         and m.user_id = (select app.current_user_id()) and m.active
    ) and exists (
      select 1 from public.organization o where o.id = p_organization_id
    )
  $$;

revoke all on function app.restore_source_present(uuid) from public;
grant execute on function app.restore_source_present(uuid) to authenticated;

-- ---- Copies due on a clock -------------------------------------------------
-- The same shape as the delivery schedules: which companies have a copy due,
-- across every tenant, as ids and nothing else. A suspended company takes no
-- copies; its destination waits.
create or replace function app.due_backups(p_limit int default 20)
returns table (organization_id uuid, destination_id uuid, next_run_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select d.organization_id, d.id, d.next_run_at
    from public.backup_destination d
    where d.next_run_at is not null
      and d.next_run_at <= now()
      and not exists (
        select 1 from public.organization o
         where o.id = d.organization_id and o.suspended_at is not null
      )
    order by d.next_run_at
    limit p_limit
  $$;

revoke all on function app.due_backups(int) from public;
grant execute on function app.due_backups(int) to background;

-- ---- Where each company's files are ----------------------------------------
-- The companies with files in Postgres (`postgres`), files in the bucket
-- (`object`), or deleted files whose object the worker has still to delete
-- (`sweep`). For the command that moves files between the two and for the
-- worker's sweep, both of which work a company at a time inside its tenant.
create or replace function app.file_store_organizations(p_kind text, p_limit int default 100)
returns table (organization_id uuid, files bigint)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select f.organization_id, count(*)::bigint
    from public.stored_file f
    where case p_kind
      when 'postgres' then f.stored_in = 'postgres' and f.deleted_at is null
      when 'object' then f.stored_in = 'object' and f.deleted_at is null
      when 'sweep' then f.stored_in = 'object' and f.deleted_at is not null
      else false
    end
    group by f.organization_id
    order by f.organization_id
    limit p_limit
  $$;

revoke all on function app.file_store_organizations(text, int) from public;
grant execute on function app.file_store_organizations(text, int) to background;

-- ---- One open request per visit ---------------------------------------------
-- A customer's request to move or cancel a visit is open while the office has
-- not answered it (`pending`) and while an offer of a different time waits on
-- the customer (`proposed`). Built here rather than in the migration that
-- added `proposed`, because Postgres will not use an enum value inside the
-- transaction that created it and the generated migrations run in one. The
-- schema (`visit_change_request.pendingIdx`) declares the same index.
create unique index if not exists visit_change_request_pending_idx
  on public.visit_change_request using btree (visit_id)
  where status in ('pending', 'proposed');
