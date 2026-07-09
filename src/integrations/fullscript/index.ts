// Fullscript integration — reached only through Practice Better (see config.ts
// for the full rationale). No direct Fullscript API, no credentials, no webhooks:
// Fullscript exposes none of those to this client. The PB bridge lives in
// `src/integrations/pb/` (protocol reads carry the Fullscript plan's externalId +
// failure flags; the dispensary-failure reconcile job surfaces failed pushes).
//
// This module now holds only the one Fullscript value we legitimately keep: the
// public dispensary storefront URL for client-facing refill deep-links.

export { fullscriptDispensaryUrl } from './config';
