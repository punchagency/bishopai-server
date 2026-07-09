import { logEvent, logWarn, logError } from '../../observability/logger';
import { isPbConfigured } from './config';
import { getFullscriptAccountSettings } from './reads';
import type { PbFullscriptAccountSettings } from './types';

// Fullscript-in-PB readiness check. Our prepare-and-hand-off (WF4) relies on
// Nicole's PB Fullscript settings being right: publishing a protocol only reaches
// Fullscript when the account is linked and `autoCreateTreatmentPlans` is on.
//
// PB documents no GET endpoint for these settings, so this pre-flight is OPT-IN:
// it runs only when PB_FULLSCRIPT_SETTINGS_PATH points at a confirmed path.
// Otherwise the primary push-failure signal is the dispensary reconcile
// (reconcileDispensaryPushes) — it catches failures after the fact from the
// protocol's own flags. See [[fullscript-via-pb-only]].

export type ReadinessSeverity = 'blocker' | 'warning';

export interface ReadinessIssue {
  severity: ReadinessSeverity;
  message: string;
}

/**
 * Evaluate the Fullscript-in-PB settings into actionable issues. Pure — exported
 * for tests. `blocker` = the hand-off cannot reach Fullscript at all; `warning`
 * = it works but with a caveat worth flagging.
 */
export function evaluateFullscriptReadiness(s: PbFullscriptAccountSettings): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];

  if (!s.practitionerId) {
    // Not linked → nothing else matters; publishing a protocol won't create a plan.
    issues.push({
      severity: 'blocker',
      message: 'Fullscript is not linked in Practice Better (no practitionerId) — refill hand-offs will not reach Fullscript. Nicole must connect Fullscript under PB → Integrations.',
    });
    return issues;
  }

  if (!s.autoCreateTreatmentPlans) {
    issues.push({
      severity: 'blocker',
      message: 'PB setting `autoCreateTreatmentPlans` is off — publishing a protocol will NOT auto-create the Fullscript plan. Turn it on so WF4 hand-offs complete.',
    });
  }
  if (!s.matchPatientsByEmailAddress) {
    issues.push({
      severity: 'warning',
      message: 'PB setting `matchPatientsByEmailAddress` is off — existing Fullscript patients may not be matched, risking duplicate patient records.',
    });
  }

  return issues;
}

export interface FullscriptReadiness {
  checked: boolean; // false = skipped (PB not configured / read failed)
  linked: boolean;
  issues: ReadinessIssue[];
}

/**
 * Read the Fullscript-in-PB settings and log any issues. Best-effort: never
 * throws, so it's safe to fire-and-forget at startup. No-op when PB isn't
 * configured or the settings endpoint isn't reachable (e.g. path unconfirmed).
 */
export async function checkFullscriptPbReadiness(): Promise<FullscriptReadiness> {
  if (!isPbConfigured()) return { checked: false, linked: false, issues: [] };

  const path = process.env.PB_FULLSCRIPT_SETTINGS_PATH;
  if (!path) {
    logEvent('info', 'pb.fullscript', 'Fullscript settings pre-flight skipped (PB_FULLSCRIPT_SETTINGS_PATH unset) — relying on dispensary reconcile for push-failure signal', {});
    return { checked: false, linked: false, issues: [] };
  }

  let settings: PbFullscriptAccountSettings;
  try {
    settings = await getFullscriptAccountSettings(path);
  } catch (err) {
    logError('pb.fullscript', 'could not read Fullscript-in-PB settings; skipping readiness check', err, {
      path,
    });
    return { checked: false, linked: false, issues: [] };
  }

  const issues = evaluateFullscriptReadiness(settings);
  for (const issue of issues) {
    logWarn('pb.fullscript', `Fullscript readiness ${issue.severity}: ${issue.message}`, {
      severity: issue.severity,
    });
  }
  if (issues.length === 0) {
    logEvent('info', 'pb.fullscript', 'Fullscript-in-PB linked and configured for hand-off', {
      clinic_id: settings.clinicId,
      country: settings.country,
    });
  }

  return { checked: true, linked: !!settings.practitionerId, issues };
}
