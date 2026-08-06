import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createSubscription, listSubscriptions } from '../src/integrations/pb/webhooks';
import { isPbConfigured } from '../src/integrations/pb/config';

async function main() {
  if (!isPbConfigured()) {
    console.error('PB_CLIENT_ID and PB_CLIENT_SECRET must be set in environment.');
    process.exit(1);
  }

  const endpointUrl =
    process.argv[2] ||
    'https://innerlume-server-production.up.railway.app/webhooks/pb/session';

  console.log('Fetching existing webhook subscriptions from Practice Better API...');
  try {
    const subs = await listSubscriptions();
    console.log('Existing subscriptions:', JSON.stringify(subs, null, 2));
  } catch (err) {
    console.warn('Could not list subscriptions:', err instanceof Error ? err.message : String(err));
  }

  const verificationToken = randomUUID();
  console.log(`\nRegistering new webhook subscription pointing to ${endpointUrl}...`);
  try {
    const res = await createSubscription({
      endpointUrl,
      eventTypes: ['session.created', 'session.updated', 'session.cancelled', 'session.confirmed'],
      description: 'Innerlume Railway Server Webhook',
      verificationToken,
    });
    console.log('\n🎉 Practice Better Webhook subscription created successfully!');
    console.log(JSON.stringify(res, null, 2));

    if (res.plaintextSigningSecret) {
      console.log('\n======================================================');
      console.log('IMPORTANT: Set this signing secret in Railway:');
      console.log(`PB_SIGNING_SECRET=${res.plaintextSigningSecret}`);
      console.log('======================================================\n');
    }
  } catch (err) {
    console.error('Failed to create subscription:', err instanceof Error ? err.message : String(err));
  }
}

void main();
