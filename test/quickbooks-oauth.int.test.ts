import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { getQuickbooksAccessToken, _resetQuickbooksTokenCache } from '../src/integrations/quickbooks/oauth';

// OAuth token manager: refresh grant (Basic-auth header, flat response),
// in-process caching, and rotated-refresh persistence to integration_state.
// DB-gated (persistence uses integration_state).
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;
const REFRESH_KEY = 'quickbooks.refresh_token';

suite('quickbooks OAuth token manager (integration)', () => {
  const saved = { ...process.env };

  beforeAll(() => pool.query(`DELETE FROM integration_state WHERE key = $1`, [REFRESH_KEY]).then(() => {}));
  beforeEach(() => {
    _resetQuickbooksTokenCache();
    process.env.QB_CLIENT_ID = 'cid';
    process.env.QB_CLIENT_SECRET = 'csecret';
    process.env.QB_REFRESH_TOKEN = 'seed-refresh';
    process.env.QB_REALM_ID = 'realm-1';
  });
  afterEach(async () => {
    process.env = { ...saved };
    await pool.query(`DELETE FROM integration_state WHERE key = $1`, [REFRESH_KEY]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('mints an access token via the refresh grant, with Basic auth, and caches it', async () => {
    let calls = 0;
    const post = async (_url: string, form: URLSearchParams, authHeader: string) => {
      calls++;
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('seed-refresh');
      // client creds ride in the Basic header, NOT the body.
      expect(form.get('client_id')).toBeNull();
      expect(authHeader).toBe('Basic ' + Buffer.from('cid:csecret').toString('base64'));
      return { access_token: 'acc-1', expires_in: 3600 };
    };
    expect(await getQuickbooksAccessToken({ post })).toBe('acc-1');
    expect(await getQuickbooksAccessToken({ post })).toBe('acc-1'); // cached, no 2nd call
    expect(calls).toBe(1);
  });

  it('persists a rotated refresh token and uses it next time', async () => {
    const post1 = async (_url: string, form: URLSearchParams) => {
      expect(form.get('refresh_token')).toBe('seed-refresh');
      return { access_token: 'acc-1', refresh_token: 'rotated-refresh', expires_in: 3600 };
    };
    await getQuickbooksAccessToken({ post: post1 });

    const stored = await pool.query<{ value: string }>(`SELECT value FROM integration_state WHERE key = $1`, [REFRESH_KEY]);
    expect(stored.rows[0].value).toBe('rotated-refresh');

    // New process (cache cleared) → next refresh uses the rotated token, not the seed.
    _resetQuickbooksTokenCache();
    const post2 = async (_url: string, form: URLSearchParams) => {
      expect(form.get('refresh_token')).toBe('rotated-refresh');
      return { access_token: 'acc-2', expires_in: 3600 };
    };
    expect(await getQuickbooksAccessToken({ post: post2 })).toBe('acc-2');
  });
});
