import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { getQuickbooksAccessToken, _resetQuickbooksTokenCache } from '../src/integrations/quickbooks/oauth';

// OAuth token manager: refresh grant (Basic-auth header, flat response),
// in-process caching, and rotated-refresh persistence to integration_state.
// Emulator-gated (persistence uses integration_state).
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[quickbooks-oauth.int] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}
const REFRESH_KEY = 'quickbooks.refresh_token';

suite('quickbooks OAuth token manager (integration)', () => {
  const saved = { ...process.env };
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('quickbooks-oauth-int');
  });
  beforeEach(async () => {
    await clearFirestore(db);
    _resetQuickbooksTokenCache();
    process.env.QB_CLIENT_ID = 'cid';
    process.env.QB_CLIENT_SECRET = 'csecret';
    process.env.QB_REFRESH_TOKEN = 'seed-refresh';
    process.env.QB_REALM_ID = 'realm-1';
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  afterAll(() => uninstallFirestore());

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

    expect(await db.state.get(REFRESH_KEY)).toBe('rotated-refresh');

    // New process (cache cleared) → next refresh uses the rotated token, not the seed.
    _resetQuickbooksTokenCache();
    const post2 = async (_url: string, form: URLSearchParams) => {
      expect(form.get('refresh_token')).toBe('rotated-refresh');
      return { access_token: 'acc-2', expires_in: 3600 };
    };
    expect(await getQuickbooksAccessToken({ post: post2 })).toBe('acc-2');
  });
});
