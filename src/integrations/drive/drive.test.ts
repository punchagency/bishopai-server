import { describe, it, expect, vi, afterEach } from 'vitest';
import { isDriveConfigured, driveConfig, publishDocument } from './index';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
});

describe('drive config gating', () => {
  it('isDriveConfigured reflects env', () => {
    expect(isDriveConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
    expect(isDriveConfigured()).toBe(true);
  });

  it('driveConfig throws when unset', () => {
    expect(() => driveConfig()).toThrow(/not configured/);
  });
});

describe('publishDocument', () => {
  it('dry-runs (no fetch) when Drive is unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishDocument({ clientName: 'Jane Doe', title: 'Protocol', markdown: '# hi' });
    expect(result.dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // never touches Google when unconfigured
  });
});
