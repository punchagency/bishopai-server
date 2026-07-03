import type { RequestHandler } from 'express';
import { getAuthConfig, verifyToken } from './service';

/** Bearer token from the Authorization header, if present. */
export function bearer(req: { get(name: string): string | undefined }): string | undefined {
  const h = req.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/**
 * Guard the dashboard API. A pass-through when auth is disabled (Nicole's
 * Settings toggle is off / fresh install); when enabled, requires a valid,
 * unexpired session token. Enforced server-side so the toggle is real security,
 * not just a UI gate.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  void (async () => {
    const cfg = await getAuthConfig();
    if (!cfg.enabled) return next();
    if (verifyToken(bearer(req), cfg.tokenSecret)) return next();
    res.status(401).json({ error: 'unauthorized', auth_required: true });
  })().catch(next);
};
