import { describe, it, expect } from 'vitest';
import { shouldRefuseRemoteTestDb } from './pool';

// The rule that stops `npm test` writing to production. Worth testing directly:
// its failure mode is silent — the integration suites just run, against whatever
// answered, and you find out from the row counts afterwards.
describe('shouldRefuseRemoteTestDb', () => {
  const remote = 'postgresql://u:p@gondola.proxy.rlwy.net:21544/railway';
  const local = 'postgresql://u:p@localhost:5432/bishop';

  it('refuses a remote database under vitest', () => {
    expect(shouldRefuseRemoteTestDb({ VITEST: 'true', DATABASE_URL: remote })).toBe(true);
  });

  it('allows a local database under vitest', () => {
    expect(shouldRefuseRemoteTestDb({ VITEST: 'true', DATABASE_URL: local })).toBe(false);
    expect(
      shouldRefuseRemoteTestDb({ VITEST: 'true', DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/b' }),
    ).toBe(false);
  });

  it('leaves the app alone outside vitest', () => {
    // The server and scripts/ tools legitimately talk to production.
    expect(shouldRefuseRemoteTestDb({ DATABASE_URL: remote })).toBe(false);
  });

  it('honours an explicit opt-in', () => {
    expect(
      shouldRefuseRemoteTestDb({ VITEST: 'true', DATABASE_URL: remote, ALLOW_REMOTE_TEST_DB: 'true' }),
    ).toBe(false);
  });

  it('treats a missing DATABASE_URL as not-local rather than assuming safety', () => {
    expect(shouldRefuseRemoteTestDb({ VITEST: 'true' })).toBe(true);
  });
});
