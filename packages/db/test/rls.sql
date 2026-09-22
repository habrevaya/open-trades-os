-- pgTAP. Run with: pnpm db:test
--
-- These are not optional tests. Every assertion here is a cross-tenant data
-- leak that shipped to production if it fails.

begin;
select plan(12);

-- Two tenants, one row each.
insert into organization (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111', 'Acme HVAC', 'acme'),
  ('22222222-2222-2222-2222-222222222222', 'Beta Plumbing', 'beta');

insert into customer (id, organization_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Acme Customer'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Beta Customer');

-- ---- Tenant A sees only tenant A ---------------------------------------
select set_config('app.organization_id', '11111111-1111-1111-1111-111111111111', true);

select is((select count(*) from customer)::int, 1,
  'tenant A sees exactly its own customers');
select is((select name from customer), 'Acme Customer',
  'tenant A sees the right customer');
select is((select count(*) from organization)::int, 1,
  'tenant A sees only its own organization row');

-- ---- Tenant A cannot write into tenant B -------------------------------
select throws_ok(
  $$insert into customer (organization_id, name)
    values ('22222222-2222-2222-2222-222222222222', 'Smuggled')$$,
  '42501',
  null,
  'tenant A cannot insert a row belonging to tenant B'
);

select is((select count(*) from customer
           where id = 'bbbbbbbb-0000-0000-0000-000000000001')::int, 0,
  'tenant A cannot read tenant B by direct id lookup');

-- ---- Unset context sees nothing, not everything -------------------------
select set_config('app.organization_id', '', true);
select is((select count(*) from customer)::int, 0,
  'an unset tenant context returns zero rows, never all rows');

-- ---- Ledger guards ------------------------------------------------------
select set_config('app.organization_id', '11111111-1111-1111-1111-111111111111', true);

insert into ledger_entry (organization_id, transaction_id, direction, account_code, amount, source_type, source_id)
values
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'debit',  '1200', 100.0000, 'invoice', '44444444-4444-4444-4444-444444444444'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'credit', '4000', 100.0000, 'invoice', '44444444-4444-4444-4444-444444444444');

select throws_ok(
  $$update ledger_entry set amount = 999 where account_code = '1200'$$,
  null, null,
  'ledger entries cannot be updated'
);

select throws_ok(
  $$delete from ledger_entry where account_code = '1200'$$,
  null, null,
  'ledger entries cannot be deleted'
);

select throws_ok(
  $$insert into ledger_entry (organization_id, transaction_id, direction, account_code, amount, source_type, source_id)
    values ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'debit', '1200', 50.0000, 'invoice', '44444444-4444-4444-4444-444444444444')$$,
  null, null,
  'an unbalanced ledger transaction is rejected at commit'
);

-- ---- The network layer must not widen the tenant boundary ---------------
-- This is the assertion that matters most on the whole file. A franchise or a
-- holding company brings several organizations under one owner, and the
-- temptation is to let the parent read across them. It must not, except
-- through an explicit grant for a named aggregate.

insert into network (id, kind, name, slug)
values ('66666666-6666-6666-6666-666666666666', 'franchise', 'Acme Brands', 'acme-brands');

update organization set network_id = '66666666-6666-6666-6666-666666666666'
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');

select set_config('app.organization_id', '11111111-1111-1111-1111-111111111111', true);

select is((select count(*) from network)::int, 1,
  'a member sees the network it belongs to');

select is((select count(*) from customer)::int, 1,
  'sharing a network does NOT let tenant A read tenant B customers');

select is((select count(*) from organization)::int, 1,
  'sharing a network does NOT let tenant A read tenant B organization rows');

select * from finish();
rollback;
