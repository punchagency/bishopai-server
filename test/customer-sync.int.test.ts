import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { matchCustomer, normalizeName, syncCustomerMappings } from '../src/checkout/customerSync';
import { normalizeCustomer, type Customer } from '../src/integrations/quickbooks/customer';
import { resolveQboCustomerId, setQboCustomerId } from '../src/checkout/customerMap';

const cust = (id: string, displayName: string, email?: string, active = true): Customer => ({
  id,
  displayName,
  email,
  active,
});

// --- Pure matcher (no DB/network) -------------------------------------------
describe('matchCustomer — only unambiguous exact matches', () => {
  const customers = [
    cust('1', 'Maya Chen', 'maya@x.com'),
    cust('2', 'David Osei', 'david@x.com'),
    cust('3', 'Maya Chen', 'other@x.com'), // same name as #1 → name is ambiguous
    cust('4', 'Inactive Ivy', 'ivy@x.com', false),
  ];

  it('matches by email (case/space-insensitive)', () => {
    const m = matchCustomer({ name: 'Whatever', email: '  MAYA@X.com ' }, customers);
    expect(m).toMatchObject({ via: 'email', customerId: '1', ambiguous: false });
  });

  it('flags ambiguous when an email hits more than one active customer', () => {
    const dup = [cust('a', 'A', 'dup@x.com'), cust('b', 'B', 'dup@x.com')];
    const m = matchCustomer({ name: 'A', email: 'dup@x.com' }, dup);
    expect(m).toMatchObject({ via: 'email', ambiguous: true, candidateIds: ['a', 'b'] });
    expect(m.customerId).toBeUndefined();
  });

  it('falls back to exact display name when no email match', () => {
    const m = matchCustomer({ name: 'david osei', email: null }, customers);
    expect(m).toMatchObject({ via: 'name', customerId: '2', ambiguous: false });
  });

  it('is ambiguous when a name matches more than one customer', () => {
    const m = matchCustomer({ name: 'Maya Chen', email: null }, customers);
    expect(m).toMatchObject({ via: 'name', ambiguous: true });
    expect(m.candidateIds.sort()).toEqual(['1', '3']);
  });

  it('ignores inactive customers', () => {
    const m = matchCustomer({ name: 'Inactive Ivy', email: 'ivy@x.com' }, customers);
    expect(m.via).toBe('none');
  });

  it('returns none when nothing matches', () => {
    expect(matchCustomer({ name: 'Nobody', email: 'no@x.com' }, customers).via).toBe('none');
  });

  it('normalizeName collapses case/whitespace', () => {
    expect(normalizeName('  Maya   Chen ')).toBe('maya chen');
  });
});

describe('normalizeCustomer', () => {
  it('reads email + builds a display name from given/family when absent', () => {
    expect(normalizeCustomer({ Id: '9', GivenName: 'Maya', FamilyName: 'Chen', PrimaryEmailAddr: { Address: 'm@x.com' } }))
      .toEqual({ id: '9', displayName: 'Maya Chen', email: 'm@x.com', givenName: 'Maya', familyName: 'Chen', active: undefined });
  });
});

// --- Integration: the apply logic against real tables (injected customers) ---
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

suite('syncCustomerMappings (integration)', () => {
  const saved = { ...process.env };
  const clientIds: string[] = [];

  const addClient = async (name: string, email: string | null) => {
    const r = await pool.query<{ id: string }>(`INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`, [name, email]);
    clientIds.push(r.rows[0].id);
    return r.rows[0].id;
  };

  beforeEach(() => {
    process.env.QB_CLIENT_ID = 'cid';
    process.env.QB_CLIENT_SECRET = 'sec';
    process.env.QB_REFRESH_TOKEN = 'rt';
    process.env.QB_REALM_ID = 'realm';
  });
  afterEach(async () => {
    process.env = { ...saved };
    for (const id of clientIds.splice(0)) await pool.query(`DELETE FROM clients WHERE id = $1`, [id]); // cascades to map
  });
  afterAll(async () => {
    await pool.end();
  });

  it('auto-maps unambiguous matches, skips already-mapped, and reports ambiguous/unmatched', async () => {
    const maya = await addClient('Maya Chen', 'maya@x.com'); // email match → mapped
    const david = await addClient('David Osei', null); // name match → mapped
    const twin = await addClient('Twin Name', null); // two customers share the name → ambiguous
    const ghost = await addClient('Ghost Client', 'ghost@x.com'); // no customer → unmatched
    const preset = await addClient('Preset Client', 'preset@x.com'); // already mapped → skipped
    await setQboCustomerId(preset, 'PRE-1');

    const customers: Customer[] = [
      cust('C-MAYA', 'Maya C', 'maya@x.com'), // email wins even though name differs
      cust('C-DAVID', 'David Osei'),
      cust('C-T1', 'Twin Name'),
      cust('C-T2', 'Twin Name'),
      cust('C-PRE', 'Preset Client', 'preset@x.com'),
    ];

    const report = await syncCustomerMappings({ fetchCustomers: async () => customers });

    // The sync scans ALL unmapped clients (correct for prod); a shared test DB
    // may hold other clients, so assert on OUR clients by membership.
    expect(report.ok).toBe(true);
    expect(report.alreadyMapped).toBeGreaterThanOrEqual(1);
    expect(report.mapped.find((m) => m.clientId === maya)).toMatchObject({ qboCustomerId: 'C-MAYA', via: 'email' });
    expect(report.mapped.find((m) => m.clientId === david)).toMatchObject({ qboCustomerId: 'C-DAVID', via: 'name' });
    expect(report.ambiguous.find((a) => a.clientId === twin)).toMatchObject({ via: 'name', candidateIds: expect.arrayContaining(['C-T1', 'C-T2']) });
    expect(report.unmatched.some((u) => u.clientId === ghost)).toBe(true);
    // Ambiguous/unmatched are never auto-mapped.
    expect(report.mapped.some((m) => m.clientId === twin || m.clientId === ghost)).toBe(false);

    // Applied to the table; preset untouched.
    expect(await resolveQboCustomerId(maya)).toBe('C-MAYA');
    expect(await resolveQboCustomerId(david)).toBe('C-DAVID');
    expect(await resolveQboCustomerId(twin)).toBeNull();
    expect(await resolveQboCustomerId(ghost)).toBeNull();
    expect(await resolveQboCustomerId(preset)).toBe('PRE-1');
  });

  it('returns ok:false when QuickBooks is not configured', async () => {
    delete process.env.QB_CLIENT_ID;
    const report = await syncCustomerMappings({ fetchCustomers: async () => [] });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/not configured/);
  });
});
