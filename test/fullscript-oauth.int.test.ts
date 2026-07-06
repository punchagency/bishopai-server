import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { getFullscriptAccessToken, _resetFullscriptTokenCache } from '../src/integrations/fullscript/oauth';

// OAuth token manager: refresh grant, in-process caching, and rotated-refresh
// persistence to integration_state. DB-gated (persistence uses integration_state).
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;
const REFRESH_KEY = 'fullscript.refresh_token';

suite('fullscript OAuth token manager (integration)', () => {
  const saved = { ...process.env };

  beforeAll(() => pool.query(`DELETE FROM integration_state WHERE key = $1`, [REFRESH_KEY]).then(() => {}));
  beforeEach(() => {
    _resetFullscriptTokenCache();
    process.env.FULLSCRIPT_CLIENT_ID = 'cid';
    process.env.FULLSCRIPT_CLIENT_SECRET = 'csecret';
    process.env.FULLSCRIPT_REFRESH_TOKEN = 'seed-refresh';
  });
  afterEach(async () => {
    process.env = { ...saved };
    await pool.query(`DELETE FROM integration_state WHERE key = $1`, [REFRESH_KEY]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('mints an access token via the refresh grant and caches it', async () => {
    let calls = 0;
    const post = async (_url: string, form: URLSearchParams) => {
      calls++;
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('seed-refresh');
      expect(form.get('client_id')).toBe('cid');
      return { oauth: { access_token: 'acc-1', expires_in: 7200 } };
    };
    expect(await getFullscriptAccessToken({ post })).toBe('acc-1');
    expect(await getFullscriptAccessToken({ post })).toBe('acc-1'); // cached, no 2nd call
    expect(calls).toBe(1);
  });

  it('persists a rotated refresh token and uses it next time', async () => {
    const post1 = async (_url: string, form: URLSearchParams) => {
      expect(form.get('refresh_token')).toBe('seed-refresh');
      return { oauth: { access_token: 'acc-1', refresh_token: 'rotated-refresh', expires_in: 7200 } };
    };
    await getFullscriptAccessToken({ post: post1 });

    const stored = await pool.query<{ value: string }>(`SELECT value FROM integration_state WHERE key = $1`, [REFRESH_KEY]);
    expect(stored.rows[0].value).toBe('rotated-refresh');

    // New process (cache cleared) → next refresh uses the rotated token, not the seed.
    _resetFullscriptTokenCache();
    const post2 = async (_url: string, form: URLSearchParams) => {
      expect(form.get('refresh_token')).toBe('rotated-refresh');
      return { oauth: { access_token: 'acc-2', expires_in: 7200 } };
    };
    expect(await getFullscriptAccessToken({ post: post2 })).toBe('acc-2');
  });
});
