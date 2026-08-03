import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { updateAuthConfig } from '../src/auth/service';

// Integration tests: the real Express app + the Firestore emulator, over an
// ephemeral port. Emulator-gated, so `vitest run` still passes without one.
const up = await emulatorUp();
if (!up) {
  console.log('[routes.integration] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

describe.skipIf(!up)('routes (integration)', () => {
  let server: http.Server;
  let base = '';
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore('routes-integration');
    await clearFirestore(db);
    // auth_config is a single document keyed on its own id, so seeding it is
    // just the write the service already makes - no INSERT ... ON CONFLICT.
    await updateAuthConfig({ enabled: false }); // known state: login off
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await updateAuthConfig({ enabled: false }); // leave login off for the demo
    await new Promise<void>((r) => server.close(() => r()));
    uninstallFirestore();
  });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  const put = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('serves the dashboard API when login is off', async () => {
    for (const path of ['/dashboard/overview', '/refills/digest', '/engagement/leads', '/checkout']) {
      expect((await get(path)).status, path).toBe(200);
    }
  });

  it('health is always open', async () => {
    expect((await get('/health')).status).toBe(200);
  });

  it('enforces login end-to-end: enable → 401 → login → 200 → disable → 200', async () => {
    // Enable + set a password (allowed while auth is off — bootstrap).
    expect((await put('/auth/settings', { enabled: true, password: 'test-secret-123' })).status).toBe(200);
    expect(await (await get('/auth/status')).json()).toMatchObject({ enabled: true, configured: true });

    // Guarded route now rejects an unauthenticated request.
    expect((await get('/refills/digest')).status).toBe(401);

    // Wrong password is rejected; correct password mints a token.
    expect((await post('/auth/login', { password: 'nope' })).status).toBe(401);
    const { token } = await (await post('/auth/login', { password: 'test-secret-123' })).json();
    expect(token).toBeTruthy();

    // Token unlocks the guarded route.
    expect((await get('/refills/digest', token)).status).toBe(200);

    // Settings change needs the token once auth is on.
    expect((await put('/auth/settings', { enabled: false })).status).toBe(401);
    expect((await put('/auth/settings', { enabled: false }, token)).status).toBe(200);

    // Back to open.
    expect((await get('/refills/digest')).status).toBe(200);
  });

  it('rejects an unknown appointment on checkout/detect', async () => {
    const res = await post('/checkout/detect', { appointment_id: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });
});
