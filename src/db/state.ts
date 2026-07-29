import { getDatabase } from './index.js';

// Tiny key/value accessor over `integration_state` — for integration sync cursors
// and OAuth refresh state (the Outlook inbox poller, and the Outlook + QuickBooks
// token managers). Kept trivial on purpose.
//
// This MUST be durable. An in-memory Map here passes every test and then loses
// every cursor on restart — and on each Cloud Function cold start, where the
// process is recycled constantly — which silently breaks token refresh and makes
// the inbox poller re-read or skip mail.

export async function getState(key: string): Promise<string | null> {
  return getDatabase().state.get(key);
}

export async function setState(key: string, value: string): Promise<void> {
  await getDatabase().state.set(key, value);
}

export async function delState(key: string): Promise<void> {
  await getDatabase().state.delete(key);
}
