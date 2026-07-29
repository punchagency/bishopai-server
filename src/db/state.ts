import { getDatabase } from './index.js';

// State map fallback for integration sync cursors (e.g. Outlook poller)
const stateMap = new Map<string, string>();

export async function getState(key: string): Promise<string | null> {
  return stateMap.get(key) ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  stateMap.set(key, value);
}

export async function delState(key: string): Promise<void> {
  stateMap.delete(key);
}
