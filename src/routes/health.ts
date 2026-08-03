import { Router } from 'express';
import { getDatabase } from '../db/index.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    // `SELECT 1` has no Firestore equivalent — there is no connection to check,
    // because the Admin SDK is stateless and authenticates per request. So the
    // liveness probe is the cheapest real read there is: one lookup of a
    // document that need not exist. It proves the credentials resolve and the
    // backend answers, which is what "db: up" was ever claiming.
    await getDatabase().state.get('health');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});
