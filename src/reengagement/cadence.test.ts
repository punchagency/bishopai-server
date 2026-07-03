import { describe, it, expect } from 'vitest';
import { nextCadenceAction, DEACTIVATE_AFTER_DAYS, type LeadState } from './cadence';

const NOW = new Date('2026-07-03T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function lead(partial: Partial<LeadState>): LeadState {
  return { status: 'new', created_at: daysAgo(0), last_touch: null, sentSteps: [], ...partial };
}

describe('nextCadenceAction — inquiry track', () => {
  it('sends welcome to a brand-new lead', () => {
    const a = nextCadenceAction(lead({ created_at: daysAgo(0) }), NOW);
    expect(a).toMatchObject({ kind: 'send', step: 'welcome' });
  });

  it('skips already-sent steps and sends the next due one', () => {
    const a = nextCadenceAction(lead({ created_at: daysAgo(4), sentSteps: ['welcome'] }), NOW);
    expect(a).toMatchObject({ kind: 'send', step: 'nudge_3d' });
  });

  it('does nothing when the next step is not yet due', () => {
    // day 1: welcome already sent, nudge_3d not due until day 3.
    const a = nextCadenceAction(lead({ created_at: daysAgo(1), sentSteps: ['welcome'] }), NOW);
    expect(a.kind).toBe('none');
  });

  it('walks through to the final step by day 14', () => {
    const a = nextCadenceAction(
      lead({ created_at: daysAgo(20), sentSteps: ['welcome', 'nudge_3d', 'nudge_7d'] }),
      NOW,
    );
    expect(a).toMatchObject({ kind: 'send', step: 'final_14d' });
  });
});

describe('nextCadenceAction — stop conditions', () => {
  it('stops for booked / replied / closed leads', () => {
    for (const status of ['booked', 'replied', 'closed']) {
      expect(nextCadenceAction(lead({ status, created_at: daysAgo(10) }), NOW).kind).toBe('none');
    }
  });

  it('stops when the lead has an upcoming booking', () => {
    expect(nextCadenceAction(lead({ hasUpcomingBooking: true, created_at: daysAgo(10) }), NOW).kind).toBe('none');
  });
});

describe('nextCadenceAction — cancelled track', () => {
  it('sends the 7-day reschedule prompt', () => {
    const a = nextCadenceAction(lead({ status: 'cancelled', created_at: daysAgo(8) }), NOW);
    expect(a).toMatchObject({ kind: 'send', step: 'cancelled_7d' });
  });
});

describe('nextCadenceAction — deactivation', () => {
  it('deactivates a cold lead past the window with all steps sent', () => {
    const a = nextCadenceAction(
      lead({
        created_at: daysAgo(DEACTIVATE_AFTER_DAYS + 10),
        last_touch: daysAgo(DEACTIVATE_AFTER_DAYS + 1),
        sentSteps: ['welcome', 'nudge_3d', 'nudge_7d', 'final_14d'],
      }),
      NOW,
    );
    expect(a.kind).toBe('deactivate');
  });

  it('does not deactivate while a step is still due', () => {
    // Old lead but nothing sent yet → still has welcome to send.
    const a = nextCadenceAction(lead({ created_at: daysAgo(200), last_touch: daysAgo(200) }), NOW);
    expect(a.kind).toBe('send');
  });
});
