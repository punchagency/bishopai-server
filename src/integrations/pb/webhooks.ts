import { pbRequest } from './client';
import type { CreateWebhookSubscription, PbList, WebhookSubscription } from './types';

// Manage PB webhook subscriptions (verified from swagger). This is how we point
// PB at POST /webhooks/pb/session — a one-time setup once we have the OAuth2
// client. The create response returns `plaintextSigningSecret` (store as
// PB_SIGNING_SECRET); after that PB signs deliveries with PB-Signature, verified
// by requirePbSignature().

/** Register (or re-register) our webhook endpoint. Returns the signing secret once. */
export function createSubscription(body: CreateWebhookSubscription): Promise<WebhookSubscription> {
  return pbRequest('/webhooks/subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function listSubscriptions(): Promise<PbList<WebhookSubscription>> {
  return pbRequest('/webhooks/subscription');
}

/** Authoritative list of event-type names (the spec doesn't enumerate them). */
export function listEventTypes(): Promise<unknown> {
  return pbRequest('/webhooks/subscription/event/types');
}

/** Delivery log with retry/failure history — for debugging missed events. */
export function listDeliveries(): Promise<unknown> {
  return pbRequest('/webhooks/delivery');
}

export function deleteSubscription(subscriptionId: string): Promise<unknown> {
  return pbRequest(`/webhooks/subscription/${subscriptionId}`, { method: 'DELETE' });
}
