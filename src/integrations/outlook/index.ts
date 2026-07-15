import { fetchJson } from '../http';
import { logEvent } from '../../observability/logger';
import { resolveOutlookAccess } from './oauth';

export {
  isOutlookAppConfigured,
  isStaticOutlookConfigured,
  graphBaseUrl,
  outlookAppConfig,
} from './config';
export {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  disconnectOutlook,
  setPrimarySender,
  getOutlookConnection,
  getOutlookAccessToken,
  resolveOutlookAccess,
  resolveAllOutlookAccess,
  _resetOutlookTokenCache,
  type OutlookConnection,
  type OutlookAccount,
} from './oauth';

// WF3 email sender via Microsoft Graph. Dry-run gated exactly like Drive and
// Fullscript — until Outlook is connected (delegated OAuth) or a static token is
// set, sends log what they would do and report success, so the whole
// re-engagement cadence is exercisable offline and flips to real sends with no
// wiring change. Token + sender are resolved by resolveOutlookAccess (oauth.ts).

/** A file to attach to an outgoing email (e.g. a filled ROF / Supplement Protocol). */
export interface EmailAttachment {
  /** File name as the recipient sees it, e.g. "Supplement Protocol 7_9_26.xlsx". */
  name: string;
  /** Raw file bytes; base64-encoded for Graph on the way out. */
  content: Buffer;
  /** MIME type; defaults to a generic binary stream. */
  contentType?: string;
}

export interface EmailInput {
  to: string;
  subject: string;
  body: string;
  attachments?: EmailAttachment[];
}

// Graph's sendMail takes inline (base64) attachments only up to a ~3 MB request;
// past that it needs a resumable upload session against a draft message. Nicole's
// filled templates are tens of KB, so we cap and surface a clear error rather than
// carry an upload-session implementation nothing currently needs.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function graphAttachments(attachments: EmailAttachment[]): Record<string, unknown>[] {
  const total = attachments.reduce((n, a) => n + a.content.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachments total ${total} bytes, over Graph's ${MAX_ATTACHMENT_BYTES}-byte inline limit`,
    );
  }
  return attachments.map((a) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.name,
    contentType: a.contentType ?? 'application/octet-stream',
    contentBytes: a.content.toString('base64'),
  }));
}

export interface EmailResult {
  ok: boolean;
  dryRun?: boolean;
  error?: string;
}

// A normalized inbound message from the mailbox, for the WF3 inbox poller.
export interface InboundMessage {
  id: string;
  from: string; // sender email address
  subject: string;
  receivedDateTime: string; // ISO 8601
  preview?: string;
  headers?: { name: string; value: string }[]; // selected internet message headers (for spam/loop guards)
}

interface GraphMessage {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string } };
  internetMessageHeaders?: { name?: string; value?: string }[];
}

/**
 * Read inbox messages received after `sinceIso` (exclusive), oldest first, via
 * Microsoft Graph. Returns [] when Outlook isn't configured — the poller treats
 * that as a no-op, mirroring the dry-run send path. `sinceIso` null pulls the
 * most recent page (first run / no cursor yet).
 */
/** Read a mailbox's inbox. `sender` names it (else the primary); [] if not configured. */
export async function fetchInboxMessages(sinceIso: string | null, sender?: string): Promise<InboundMessage[]> {
  const access = await resolveOutlookAccess(sender);
  if (!access) return [];
  const { token, sender: mailbox, graphBase } = access;
  const params = new URLSearchParams({
    $select: 'id,subject,from,receivedDateTime,bodyPreview,internetMessageHeaders',
    $orderby: 'receivedDateTime asc',
    $top: '50',
  });
  if (sinceIso) params.set('$filter', `receivedDateTime gt ${sinceIso}`);
  const url = `${graphBase}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?${params.toString()}`;

  const res = await fetchJson<{ value?: GraphMessage[] }>(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return (res.value ?? [])
    .map((m): InboundMessage | null => {
      const from = m.from?.emailAddress?.address?.trim();
      if (!m.id || !from || !m.receivedDateTime) return null;
      const headers = (m.internetMessageHeaders ?? [])
        .filter((h): h is { name: string; value: string } => !!h.name && h.value != null)
        .map((h) => ({ name: h.name, value: h.value }));
      return {
        id: m.id,
        from,
        subject: m.subject ?? '',
        receivedDateTime: m.receivedDateTime,
        preview: m.bodyPreview,
        headers,
      };
    })
    .filter((m): m is InboundMessage => m !== null);
}

export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  const attached = input.attachments ?? [];
  const access = await resolveOutlookAccess();
  if (!access) {
    logEvent('info', 'outlook.send', '[dry-run] would send email', {
      to: input.to,
      subject: input.subject,
      attachments: attached.map((a) => a.name),
    });
    return { ok: true, dryRun: true };
  }

  const { token, sender, graphBase } = access;
  try {
    const message: Record<string, unknown> = {
      subject: input.subject,
      body: { contentType: 'Text', content: input.body },
      toRecipients: [{ emailAddress: { address: input.to } }],
    };
    if (attached.length) message.attachments = graphAttachments(attached);

    await fetchJson(`${graphBase}/users/${encodeURIComponent(sender)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    logEvent('info', 'outlook.send', 'sent email', {
      to: input.to,
      subject: input.subject,
      attachments: attached.map((a) => a.name),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
