import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispensaryStatus, reconcileDispensaryPushes } from './dispensary';
import type { PbProtocol, PbList } from './types';

const p = (over: Partial<PbProtocol>): PbProtocol => ({ id: 'proto-1', ...over });

// Mock the PB read + config so we can drive the reconcile orchestration.
const listProtocols = vi.fn<(q?: unknown) => Promise<PbList<PbProtocol>>>();
const isPbConfigured = vi.fn<() => boolean>();
vi.mock('./reads', () => ({ listProtocols: (q?: unknown) => listProtocols(q) }));
vi.mock('./config', () => ({ isPbConfigured: () => isPbConfigured() }));

describe('dispensaryStatus', () => {
  it('reports created when a Fullscript plan externalId is present', () => {
    expect(dispensaryStatus(p({ fullscriptTreatmentPlan: { externalId: 'fs_123' } }))).toBe('created');
  });

  it('reports failed when the plan-creation flag is set', () => {
    expect(dispensaryStatus(p({ fullscriptTreatmentPlanCreationFailed: true }))).toBe('failed');
  });

  it('reports failed when a dispensary recommendation failed', () => {
    expect(dispensaryStatus(p({ hasFailedDispensaryRecommendations: true }))).toBe('failed');
  });

  it('prefers failed over created when both a plan id and a failure flag exist', () => {
    expect(
      dispensaryStatus(p({ fullscriptTreatmentPlan: { externalId: 'fs_1' }, hasFailedDispensaryRecommendations: true })),
    ).toBe('failed');
  });

  it('reports none for a protocol with no Fullscript linkage', () => {
    expect(dispensaryStatus(p({ name: 'General protocol' }))).toBe('none');
  });
});

describe('reconcileDispensaryPushes', () => {
  beforeEach(() => {
    listProtocols.mockReset();
    isPbConfigured.mockReset().mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  const page = (items: PbProtocol[]): PbList<PbProtocol> => ({ items });

  it('no-ops when PB is not configured', async () => {
    isPbConfigured.mockReturnValue(false);
    const r = await reconcileDispensaryPushes();
    expect(r).toEqual({ scanned: 0, created: 0, failed: 0, failures: [] });
    expect(listProtocols).not.toHaveBeenCalled();
  });

  it('counts created vs failed and skips archived + non-dispensary protocols', async () => {
    listProtocols.mockResolvedValueOnce(
      page([
        p({ id: 'a', fullscriptTreatmentPlan: { externalId: 'fs_1' } }),
        p({ id: 'b', hasFailedDispensaryRecommendations: true, clientRecord: { name: 'Maya' } }),
        p({ id: 'c', name: 'no dispensary' }),
        p({ id: 'd', isArchived: true, fullscriptTreatmentPlanCreationFailed: true }),
      ]),
    );
    const r = await reconcileDispensaryPushes({ limit: 100 });
    expect(r.scanned).toBe(2);
    expect(r.created).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failures).toEqual([{ protocolId: 'b', protocolName: undefined, clientName: 'Maya' }]);
  });

  it('pages forward via after_id until a short page, bounded by maxPages', async () => {
    // Two full pages then a short one; assert the cursor is the last id of each page.
    listProtocols
      .mockResolvedValueOnce(page([p({ id: 'p1' }), p({ id: 'p2' })]))
      .mockResolvedValueOnce(page([p({ id: 'p3' })]));
    await reconcileDispensaryPushes({ limit: 2, maxPages: 5 });
    expect(listProtocols).toHaveBeenCalledTimes(2);
    expect(listProtocols.mock.calls[0][0]).toMatchObject({ limit: '2' });
    expect(listProtocols.mock.calls[0][0]).not.toHaveProperty('after_id');
    expect(listProtocols.mock.calls[1][0]).toMatchObject({ limit: '2', after_id: 'p2' });
  });

  it('stops at maxPages even when pages stay full', async () => {
    listProtocols.mockResolvedValue(page([p({ id: 'x' }), p({ id: 'y' })]));
    await reconcileDispensaryPushes({ limit: 2, maxPages: 3 });
    expect(listProtocols).toHaveBeenCalledTimes(3);
  });

  it('forwards the records[] client filter', async () => {
    listProtocols.mockResolvedValueOnce(page([]));
    await reconcileDispensaryPushes({ records: ['rec-1', 'rec-2'] });
    expect(listProtocols.mock.calls[0][0]).toMatchObject({ records: ['rec-1', 'rec-2'] });
  });
});
