// Fullscript connection model — via Practice Better, NOT a direct API.
//
// We cannot hold Fullscript credentials: Fullscript's Partner API is gated to
// approved EHR/tech partners, and this client reaches Fullscript only through the
// native Fullscript integration she enabled *inside* Practice Better. So this
// backend holds ZERO Fullscript secrets. Everything automatable rides on the PB
// API (`src/integrations/pb/`):
//   - WRITE (create a recommendation): no API path exists. Nicole publishes a PB
//     protocol containing the supplements; PB auto-creates the Fullscript plan
//     when her PB Fullscript setting `autoCreateTreatmentPlans` is on. WF4 is
//     therefore prepare-and-hand-off (digest → she publishes → we reconcile).
//   - READ (plan status): a PB protocol read exposes the Fullscript plan's
//     `externalId` + failure flags (`fullscriptTreatmentPlanCreationFailed`,
//     `hasFailedDispensaryRecommendations`) — but NOT the plan's product
//     contents. So "what supplements changed this session" comes from our local
//     WF1-synced plan, never from Fullscript.
//
// The only Fullscript value we keep is the public dispensary storefront URL — a
// client-facing deep-link for refill emails, not a secret.

const DEFAULT_DISPENSARY_URL = 'https://us.fullscript.com/welcome/innerlume';

/** Nicole's public Fullscript dispensary link (client-facing; not a credential). */
export function fullscriptDispensaryUrl(): string {
  return process.env.FULLSCRIPT_DISPENSARY_URL || DEFAULT_DISPENSARY_URL;
}
