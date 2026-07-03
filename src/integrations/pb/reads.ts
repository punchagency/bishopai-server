import { pbRequest } from './client';
import type { PbInvoice, PbList, PbProtocol, PbSession } from './types';

// Read endpoints the pipeline uses (paths verified from swagger). Reads only —
// the WF2 billing write-back is deferred until PB confirms the mechanism
// (Open Item #2). Add query params (paging/date filters) as the endpoints are
// exercised against real data.

/** Appointments/bookings. Correlation source + WF2 checkout context. */
export function listSessions(query?: Record<string, string>): Promise<PbList<PbSession>> {
  return pbRequest(`/consultant/sessions${qs(query)}`);
}

export function getSession(sessionId: string): Promise<PbSession> {
  return pbRequest(`/consultant/sessions/${sessionId}`);
}

/** Protocols + supplement data — WF4 refill intelligence. */
export function listProtocols(query?: Record<string, string>): Promise<PbList<PbProtocol>> {
  return pbRequest(`/consultant/protocols${qs(query)}`);
}

/** Invoices — WF2 checkout summary. */
export function listInvoices(query?: Record<string, string>): Promise<PbList<PbInvoice>> {
  return pbRequest(`/consultant/payments/invoices${qs(query)}`);
}

function qs(query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return '';
  return `?${new URLSearchParams(query).toString()}`;
}
