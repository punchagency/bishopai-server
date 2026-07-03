import { fetchJson } from '../http';
import { logEvent } from '../../observability/logger';
import { isOutlookConfigured, outlookConfig } from './config';

export { isOutlookConfigured, outlookConfig } from './config';

// WF3 email sender via Microsoft Graph. Dry-run gated exactly like Drive and
// Fullscript — until MS_GRAPH_TOKEN/SENDER are set, sends log what they would do
// and report success, so the whole re-engagement cadence is exercisable offline
// and flips to real sends with no wiring change.

export interface EmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface EmailResult {
  ok: boolean;
  dryRun?: boolean;
  error?: string;
}

export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  if (!isOutlookConfigured()) {
    logEvent('info', 'outlook.send', '[dry-run] would send email', { to: input.to, subject: input.subject });
    return { ok: true, dryRun: true };
  }

  const { token, sender, baseUrl } = outlookConfig();
  try {
    await fetchJson(`${baseUrl}/users/${encodeURIComponent(sender)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: 'Text', content: input.body },
          toRecipients: [{ emailAddress: { address: input.to } }],
        },
        saveToSentItems: true,
      }),
    });
    logEvent('info', 'outlook.send', 'sent email', { to: input.to, subject: input.subject });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
