import { describe, it, expect } from 'vitest';
import {
  nextCadenceAction,
  nextScheduledStep,
  trackNameFor,
  CADENCE_DEFAULTS,
  DEACTIVATE_AFTER_DAYS,
  type LeadState,
} from './cadence';

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

describe('nextCadenceAction — maintenance track', () => {
  it('sends the 7-day maintenance nudge (mirrors the cancelled cadence)', () => {
    const a = nextCadenceAction(lead({ status: 'maintenance', created_at: daysAgo(8) }), NOW);
    expect(a).toMatchObject({ kind: 'send', step: 'maintenance_7d' });
  });

  it('advances to the 14-day nudge once the first is sent', () => {
    const a = nextCadenceAction(
      lead({ status: 'maintenance', created_at: daysAgo(15), sentSteps: ['maintenance_7d'] }),
      NOW,
    );
    expect(a).toMatchObject({ kind: 'send', step: 'maintenance_14d' });
  });

  it('does nothing before the first nudge is due', () => {
    expect(nextCadenceAction(lead({ status: 'maintenance', created_at: daysAgo(3) }), NOW).kind).toBe('none');
  });
});

describe('nextCadenceAction — first-appointment track', () => {
  it('sends the 7-day follow-up nudge', () => {
    const a = nextCadenceAction(lead({ status: 'first_appointment', created_at: daysAgo(8) }), NOW);
    expect(a).toMatchObject({ kind: 'send', step: 'first_appt_7d' });
  });

  it('advances to the 14-day incentive once the first is sent', () => {
    const a = nextCadenceAction(
      lead({ status: 'first_appointment', created_at: daysAgo(15), sentSteps: ['first_appt_7d'] }),
      NOW,
    );
    expect(a).toMatchObject({ kind: 'send', step: 'first_appt_14d' });
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

describe('trackNameFor and CADENCE_DEFAULTS', () => {
  it('maps known statuses to proper track names and defaults to inquiry', () => {
    expect(trackNameFor('cancelled')).toBe('cancelled');
    expect(trackNameFor('maintenance')).toBe('maintenance');
    expect(trackNameFor('first_appointment')).toBe('first_appointment');
    expect(trackNameFor('new')).toBe('inquiry');
    expect(trackNameFor('contacted')).toBe('inquiry');
    expect(trackNameFor('nurturing')).toBe('inquiry');
  });

  it('populates CADENCE_DEFAULTS for all 4 tracks with non-empty subject and body', () => {
    const tracks = ['inquiry', 'cancelled', 'maintenance', 'first_appointment'];
    for (const t of tracks) {
      expect(CADENCE_DEFAULTS[t]).toBeDefined();
      expect(Object.keys(CADENCE_DEFAULTS[t]).length).toBeGreaterThan(0);
      for (const [, def] of Object.entries(CADENCE_DEFAULTS[t])) {
        expect(def.subject).toBeTruthy();
        expect(def.body).toBeTruthy();
      }
    }
  });

  it('nextScheduledStep includes the default step body', () => {
    const s = nextScheduledStep(lead({ status: 'new', created_at: daysAgo(0) }), NOW);
    expect(s).not.toBeNull();
    expect(s?.step).toBe('welcome');
    expect(s?.body).toBe(CADENCE_DEFAULTS.inquiry.welcome.body);
  });
});

