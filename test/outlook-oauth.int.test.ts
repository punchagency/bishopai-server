import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getOutlookAccessToken,
  getOutlookConnection,
  disconnectOutlook,
  setPrimarySender,
  resolveOutlookAccess,
  resolveAllOutlookAccess,
  _resetOutlookTokenCache,
} from '../src/integrations/outlook/oauth';
import { getState } from '../src/db/state';

// Outlook delegated-OAuth manager (MULTI-mailbox): connect handshake (authorize
// URL + PKCE, code exchange with /me confirmation), silent refresh-grant minting
// with rotation persistence, and the account list (connect/disconnect/primary).
// DB-gated (persists to integration_state).
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

const KEYS = ['outlook.accounts', 'outlook.refresh_token', 'outlook.sender', 'outlook.connected_at'];
async function clearState() {
  await pool.query(`DELETE FROM integration_state WHERE key = ANY($1::text[])`, [KEYS]);
  await pool.query(`DELETE FROM integration_state WHERE key LIKE 'outlook.oauth.pending:%'`);
}

interface StoredAccount {
  sender: string;
  refreshToken: string;
  primary: boolean;
}
async function storedAccounts(): Promise<StoredAccount[]> {
  return JSON.parse((await getState('outlook.accounts')) ?? '[]');
}

// Connect a mailbox end-to-end (fresh authorize state each time).
async function connect(sender: string, refresh = `r-${sender}`, access = `acc-${sender}`) {
  const state = new URL(await buildAuthorizeUrl()).searchParams.get('state')!;
  return exchangeCodeForTokens('code', state, {
    post: async () => ({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
    getMe: async () => ({ mail: sender }),
  });
}

suite('outlook OAuth manager (integration)', () => {
  const saved = { ...process.env };

  beforeAll(() => clearState());
  beforeEach(async () => {
    _resetOutlookTokenCache();
    // Ensure the static shortcut is OFF so the OAuth path is exercised.
    delete process.env.MS_GRAPH_TOKEN;
    delete process.env.MS_GRAPH_SENDER;
    process.env.MS_CLIENT_ID = 'client-abc';
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    process.env.MS_TENANT_ID = 'common';
    process.env.PUBLIC_BASE_URL = 'https://nicole.example.com';
    await clearState();
  });
  afterEach(async () => {
    process.env = { ...saved };
    await clearState();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('builds an authorize URL with PKCE + state and stashes the verifier', async () => {
    const url = await buildAuthorizeUrl();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('client_id')).toBe('client-abc');
    expect(u.searchParams.get('redirect_uri')).toBe('https://nicole.example.com/auth/outlook/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('scope')).toContain('Mail.Send');
    expect(u.searchParams.get('scope')).toContain('offline_access');

    const state = u.searchParams.get('state')!;
    const pending = JSON.parse((await getState(`outlook.oauth.pending:${state}`))!);
    expect(pending.state).toBe(state);
    expect(pending.verifier).toBeTruthy();
  });

  it('exchanges the code, stores the account (primary) + confirmed sender, and connects', async () => {
    const url = await buildAuthorizeUrl();
    const state = new URL(url).searchParams.get('state')!;

    let sentVerifier: string | null = null;
    const post = async (_url: string, form: URLSearchParams) => {
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('the-code');
      sentVerifier = form.get('code_verifier');
      return { access_token: 'acc-1', refresh_token: 'refresh-1', expires_in: 3600 };
    };
    const getMe = async (token: string) => {
      expect(token).toBe('acc-1');
      return { userPrincipalName: 'nicole@innerlumehealing.com', mail: 'hello@innerlumehealing.com' };
    };

    const { sender } = await exchangeCodeForTokens('the-code', state, { post, getMe });
    expect(sender).toBe('hello@innerlumehealing.com'); // mail preferred over UPN
    expect(sentVerifier).toBeTruthy();

    const accounts = await storedAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ sender: 'hello@innerlumehealing.com', refreshToken: 'refresh-1', primary: true });
    expect(await getState(`outlook.oauth.pending:${state}`)).toBeNull(); // consumed single-use

    const conn = await getOutlookConnection();
    expect(conn.connected).toBe(true);
    expect(conn.mode).toBe('oauth');
    expect(conn.sender).toBe('hello@innerlumehealing.com');

    // Cache was primed by the exchange — no network call needed.
    expect(await getOutlookAccessToken(undefined, { post: async () => { throw new Error('should be cached'); } })).toBe('acc-1');
  });

  it('rejects an unknown/forged state (CSRF guard)', async () => {
    await buildAuthorizeUrl();
    await expect(exchangeCodeForTokens('the-code', 'not-the-state', { post: async () => ({}) })).rejects.toThrow(
      /unknown or already-used|state/i,
    );
  });

  it('consumes the state single-use — a replay is rejected', async () => {
    const url = await buildAuthorizeUrl();
    const state = new URL(url).searchParams.get('state')!;
    const deps = {
      post: async () => ({ access_token: 'acc-1', refresh_token: 'refresh-1', expires_in: 3600 }),
      getMe: async () => ({ mail: 'hello@innerlumehealing.com' }),
    };
    await exchangeCodeForTokens('code', state, deps);
    await expect(exchangeCodeForTokens('code', state, deps)).rejects.toThrow(/unknown or already-used|state/i);
  });

  it('mints + caches access tokens and persists a rotated refresh token', async () => {
    await connect('hello@innerlumehealing.com', 'refresh-1');

    // Force a refresh (clear the primed cache); Microsoft rotates the refresh token.
    _resetOutlookTokenCache();
    let calls = 0;
    const post = async (_url: string, form: URLSearchParams) => {
      calls++;
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('refresh-1');
      return { access_token: 'acc-2', refresh_token: 'refresh-2', expires_in: 3600 };
    };
    expect(await getOutlookAccessToken(undefined, { post })).toBe('acc-2');
    expect(await getOutlookAccessToken(undefined, { post })).toBe('acc-2'); // cached, no 2nd call
    expect(calls).toBe(1);
    expect((await storedAccounts())[0].refreshToken).toBe('refresh-2'); // rotation persisted
  });

  it('resolveOutlookAccess: null when disconnected, token+sender when connected', async () => {
    expect(await resolveOutlookAccess()).toBeNull();
    await connect('hello@innerlumehealing.com', 'refresh-1', 'acc-1');

    const access = await resolveOutlookAccess();
    expect(access?.token).toBe('acc-1');
    expect(access?.sender).toBe('hello@innerlumehealing.com');

    await disconnectOutlook();
    expect(await resolveOutlookAccess()).toBeNull();
    expect((await getOutlookConnection()).connected).toBe(false);
  });

  // --- multi-mailbox ----------------------------------------------------------

  it('connects two mailboxes: first is primary, both resolvable, poller sees both', async () => {
    await connect('hello@innerlumehealing.com');
    await connect('nicole@innerlumehealing.com');

    const conn = await getOutlookConnection();
    expect(conn.accounts).toHaveLength(2);
    expect(conn.primarySender).toBe('hello@innerlumehealing.com'); // first stays primary
    expect(conn.accounts.filter((a) => a.primary)).toHaveLength(1);

    // Primary resolves for sends; a named mailbox resolves for its inbox.
    expect((await resolveOutlookAccess())?.sender).toBe('hello@innerlumehealing.com');
    expect((await resolveOutlookAccess('nicole@innerlumehealing.com'))?.sender).toBe('nicole@innerlumehealing.com');

    // The poller reads all connected inboxes.
    const all = await resolveAllOutlookAccess();
    expect(all.map((a) => a.sender).sort()).toEqual([
      'hello@innerlumehealing.com',
      'nicole@innerlumehealing.com',
    ]);
  });

  it('a second connect does not overwrite the first', async () => {
    await connect('hello@innerlumehealing.com', 'r-hello');
    await connect('nicole@innerlumehealing.com', 'r-nicole');
    const accounts = await storedAccounts();
    expect(accounts.map((a) => a.refreshToken).sort()).toEqual(['r-hello', 'r-nicole']);
  });

  it('setPrimarySender switches which mailbox WF3 sends from', async () => {
    await connect('hello@innerlumehealing.com');
    await connect('nicole@innerlumehealing.com');
    await setPrimarySender('nicole@innerlumehealing.com');

    const conn = await getOutlookConnection();
    expect(conn.primarySender).toBe('nicole@innerlumehealing.com');
    expect((await resolveOutlookAccess())?.sender).toBe('nicole@innerlumehealing.com');
    expect(conn.accounts.filter((a) => a.primary)).toHaveLength(1);
  });

  it('disconnecting one mailbox keeps the other and promotes a new primary', async () => {
    await connect('hello@innerlumehealing.com'); // primary
    await connect('nicole@innerlumehealing.com');
    await disconnectOutlook('hello@innerlumehealing.com');

    const conn = await getOutlookConnection();
    expect(conn.accounts).toHaveLength(1);
    expect(conn.primarySender).toBe('nicole@innerlumehealing.com'); // promoted
    expect(conn.connected).toBe(true);
  });
});
