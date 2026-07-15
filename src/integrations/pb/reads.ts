import { pbRequest } from './client';
import type { PbFullscriptAccountSettings, PbInvoice, PbList, PbProtocol, PbSession, CreateSessionPayload, PbService } from './types';

// Read/write endpoints the pipeline uses (paths verified from swagger).

/** Appointments/bookings. Correlation source + WF2 checkout context. */
export function listSessions(query?: Record<string, string>): Promise<PbList<PbSession>> {
  return pbRequest(`/consultant/sessions${qs(query)}`);
}

export function getSession(sessionId: string): Promise<PbSession> {
  return pbRequest(`/consultant/sessions/${sessionId}`);
}

/** Create a session for a client. WF4 booking implementation. */
export function createSession(payload: CreateSessionPayload): Promise<PbSession> {
  return pbRequest('/consultant/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** List available services. Needed to match a session type / duration. */
export function listServices(query?: Record<string, string>): Promise<PbList<PbService>> {
  return pbRequest(`/consultant/services${qs(query)}`);
}

/** Create a client record in Practice Better. */
export function createClientRecord(payload: {
  profile: {
    firstName: string;
    lastName: string;
    emailAddress: string;
  };
}): Promise<{ id: string }> {
  return pbRequest('/consultant/records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * A single client record — "records" is PB's name for clients (confirmed in
 * swagger). The session/protocol embeds only carry `id`/`name`; email lives
 * here, so anything that needs it (cancelled-cadence enrollment) fetches it
 * on demand rather than eagerly on every session sync.
 */
export function getClientRecord(id: string): Promise<{
  id: string;
  profile?: { firstName?: string; lastName?: string; emailAddress?: string };
}> {
  return pbRequest(`/consultant/records/${id}`);
}

/**
 * Protocols + Fullscript plan linkage — WF4 refill intelligence.
 * Query params (from swagger): `records[]` (client record ids — the client
 * filter), `consultants[]`, `limit` (1–100), `after_id`/`before_id` (cursors).
 */
export function listProtocols(query?: PbQuery): Promise<PbList<PbProtocol>> {
  return pbRequest(`/consultant/protocols${qs(query)}`);
}

/** Invoices — WF2 checkout summary. */
export function listInvoices(query?: Record<string, string>): Promise<PbList<PbInvoice>> {
  return pbRequest(`/consultant/payments/invoices${qs(query)}`);
}

// Fullscript-in-PB account settings (the integration levers — see readiness.ts).
// NO GET endpoint for this is documented in the PB swagger (the schema exists but
// no operation returns it). So there is no path to guess: the caller only invokes
// this when PB_FULLSCRIPT_SETTINGS_PATH is explicitly set to a confirmed path.
export function getFullscriptAccountSettings(path: string): Promise<PbFullscriptAccountSettings> {
  return pbRequest(path);
}

/** PB query values: scalars pass through; arrays repeat the key (e.g. records[]). */
export type PbQuery = Record<string, string | string[] | undefined>;

function qs(query?: PbQuery): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
