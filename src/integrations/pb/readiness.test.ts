import { describe, it, expect } from 'vitest';
import { evaluateFullscriptReadiness } from './readiness';
import type { PbFullscriptAccountSettings } from './types';

const linked: PbFullscriptAccountSettings = {
  practitionerId: 'prac-1',
  clinicId: 'clinic-1',
  country: 'US',
  autoCreateTreatmentPlans: true,
  matchPatientsByEmailAddress: true,
};

describe('evaluateFullscriptReadiness', () => {
  it('is clean when linked with the key levers on', () => {
    expect(evaluateFullscriptReadiness(linked)).toEqual([]);
  });

  it('flags a single blocker when Fullscript is not linked (and stops there)', () => {
    const issues = evaluateFullscriptReadiness({ autoCreateTreatmentPlans: false });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toMatch(/not linked/i);
  });

  it('blocks when autoCreateTreatmentPlans is off', () => {
    const issues = evaluateFullscriptReadiness({ ...linked, autoCreateTreatmentPlans: false });
    expect(issues.some((i) => i.severity === 'blocker' && /autoCreateTreatmentPlans/.test(i.message))).toBe(true);
  });

  it('warns (not blocks) when matchPatientsByEmailAddress is off', () => {
    const issues = evaluateFullscriptReadiness({ ...linked, matchPatientsByEmailAddress: false });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/matchPatientsByEmailAddress/);
  });

  it('reports both a blocker and a warning together', () => {
    const issues = evaluateFullscriptReadiness({
      practitionerId: 'prac-1',
      autoCreateTreatmentPlans: false,
      matchPatientsByEmailAddress: false,
    });
    expect(issues.map((i) => i.severity).sort()).toEqual(['blocker', 'warning']);
  });
});
