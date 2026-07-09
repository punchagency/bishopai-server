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
  sessionDate?: string;   // start (ISO). List Sessions sorts by dateCreated DESC.
  endDate?: string;       // true end time — prefer over deriving from duration
  duration?: number;      // minutes
  cancelled?: boolean;    // dedicated flag — authoritative "is this session off"
  confirmationStatus?: string;
  clientConfirmationStatus?: string;
  paymentStatus?: string;
  fee?: { amount?: number; currency?: string };
  clientRecord?: { id?: string; name?: string };
  serviceType?: string;   // 'face' | 'phone' | 'virtual'
  serviceId?: string;     // required for createSession
  upcoming?: boolean;     // response field only (NOT a query param)
}

/** Response shape from GET /consultant/availability/slots */
export interface PbAvailabilitySlot {
  startDate: string;  // ISO-8601 UTC
  endDate: string;    // ISO-8601 UTC
  duration: string;   // e.g. "PT1H"
}

/** Request body for POST /consultant/sessions */
export interface CreateSessionPayload {
  clientRecordId: string;       // required
  sessionDate: string;          // ISO-8601, required
  serviceType: string;          // 'face' | 'phone' | 'virtual', required
  serviceId: string;            // required
  duration: number;             // minutes, required
  timeZone?: string;            // IANA tz name for PB
  markConfirmed?: boolean;
  notify?: boolean;
  ignoreConflict?: boolean;     // NEVER set true — our conflict guard
  notes?: string;
}

/** A supplement line on a protocol (the protocol's OWN recommendations — distinct
 *  from the downstream Fullscript plan). Note: the recommendation has no top-level
 *  supplement name — the identity lives in the (still-opaque) `supplement` object
 *  and/or `conditionsTreated`. Confirm the `supplement` fields against live data
 *  before relying on a name here. */
export interface PbSupplementRecommendation {
  id?: string;
  dosageType?: string;
  importOnPublish?: boolean;
  supplement?: Record<string, unknown>;
  dosages?: unknown[];
  conditionsTreated?: Array<{ id?: string; name?: string; notes?: string }>;
}

export interface PbProtocol {
  id: string;
  name?: string;
  dateCreated?: string;
  startDate?: string;
  isArchived?: boolean;
  /** '' / draft / published — publish status of the protocol (values TBD live). */
  publishStatus?: string;
  /** The client this protocol belongs to (confirmed embedding). `id` is the
   *  record id used by the `records[]` filter; display name is on the profile. */
  clientRecord?: {
    id?: string;
    name?: string;
    profile?: { firstName?: string; lastName?: string; emailAddress?: string };
    client?: { id?: string; emailAddress?: string };
  };
  /** The protocol's own supplement recommendations (PB DOES expose these). */
  supplementRecommendations?: PbSupplementRecommendation[];
  // --- Fullscript linkage (confirmed from swagger) ---
  // When a protocol contains Fullscript supplements and PB's `autoCreateTreatmentPlans`
  // is on, PB pushes it to Fullscript on publish. These fields are the window into
  // the downstream Fullscript *plan* — its external id and whether the push failed.
  // (PB does not expose the Fullscript plan's contents, but the protocol's own
  // `supplementRecommendations` above are available.)
  fullscriptTreatmentPlan?: { externalId?: string };
  fullscriptTreatmentPlanCreationFailed?: boolean;
  hasFailedDispensaryRecommendations?: boolean;
}

export interface PbInvoice {
  id: string;
  status?: string;
  total?: { amount?: number; currency?: string };
  dateCreated?: string;
}

// --- Fullscript-in-PB account settings (the integration levers) ---
// Nicole's Fullscript connection lives inside PB; these flags gate whether our
// prepare-and-hand-off actually reaches Fullscript. `practitionerId` present =
// linked; `autoCreateTreatmentPlans` = publishing a protocol auto-creates the
// Fullscript plan; `matchPatientsByEmailAddress` = existing patients matched
// (avoids duplicates). Verified from swagger (FullscriptAccountSettings).
export interface PbFullscriptAccountSettings {
  practitionerId?: string;
  clinicId?: string;
  country?: string; // 'US' | 'CA'
  autoCreateTreatmentPlans?: boolean;
  matchPatientsByEmailAddress?: boolean;
  sendTreatmentEmail?: boolean;
  showRecommendationSuggestions?: boolean;
  displayTemplates?: boolean;
  disableLabs?: boolean;
  notifyOnFinalResultsOnly?: boolean;
  dateLabsSynchronized?: string | null;
}

export interface PbService {
  id: string;
  name: string;
  duration?: number;
  serviceTypes?: string[];
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
