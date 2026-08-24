/**
 * Run the correlation sweep exactly once, against whatever DATABASE_URL points at.
 *
 * The scheduler is normally what invokes this job (every 15 minutes, gated
 * behind SCHEDULER_ENABLED). This runs the same job body once so a backlog can be
 * re-examined without turning the whole scheduler on — which would also start
 * the Pocket poller and the outbound email dispatcher.
 */
import 'dotenv/config';
import { correlationSweepJob } from '../src/scheduler/jobs/correlationSweep';
import { pool } from '../src/db/pool';

const target = process.env.DATABASE_URL?.replace(/:\/\/[^:]+:[^@]+@/, '://***@') ?? '(unset)';
console.log(`running ${correlationSweepJob.name} once against ${target}`);

await correlationSweepJob.run();
await pool.end();
console.log('done');
