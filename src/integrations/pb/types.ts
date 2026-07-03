// Minimal PB shapes (from swagger). Kept light — the full field sets are
// confirmed against live responses at integration time; these cover what the
// pipeline reads today.

export interface PbList<T> {
  count?: number;
  hasMore?: boolean;
  items: T[];
}

export interface PbSession {
  id: string;
  sessionDate?: string;
  confirmationStatus?: string;
  clientConfirmationStatus?: string;
  paymentStatus?: string;
  fee?: { amount?: number; currency?: string };
  clientRecord?: { id?: string; name?: string };
  serviceType?: string;
  upcoming?: boolean;
}

export interface PbProtocol {
  id: string;
  name?: string;
  dateCreated?: string;
}

export interface PbInvoice {
  id: string;
  status?: string;
  total?: { amount?: number; currency?: string };
  dateCreated?: string;
}

// --- Webhooks (subscription management) ---

export interface CreateWebhookSubscription {
  endpointUrl: string;
  eventTypes: string[];
  verificationToken?: string;
  description?: string;
  autoEnable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WebhookSubscription {
  id: string;
  endpointUrl: string;
  events: string[];
  status?: string;
  isActive?: boolean;
  apiVersion?: string;
  /** Returned once, on creation — store as PB_SIGNING_SECRET. */
  plaintextSigningSecret?: string;
  dateCreated?: string;
  lastSuccessfulDeliveryAtUtc?: string;
}
