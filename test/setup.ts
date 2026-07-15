// Test hermeticity: DEMO_OUTPUT_DIR is a presentation switch that forces Drive
// publishes onto the local demo path. It must never alter test behavior. Setting
// it empty (rather than deleting) also survives a later transitive `dotenv/config`
// — dotenv won't override an already-present key — in case a dev put it in .env.
process.env.DEMO_OUTPUT_DIR = '';

// The suite must NEVER reach QuickBooks. Once real credentials landed in .env,
// isQuickbooksConfigured() flipped true and the checkout tests began tokenizing
// cards against Intuit's sandbox for real. Tests asserting the dry-run path must
// not depend on whether a developer happens to hold credentials, and a test run
// must never touch a payments API at all. Empty (not deleted) for the same
// dotenv-precedence reason as above.
process.env.QB_CLIENT_ID = '';
process.env.QB_CLIENT_SECRET = '';
process.env.QB_REFRESH_TOKEN = '';
process.env.QB_REALM_ID = '';
