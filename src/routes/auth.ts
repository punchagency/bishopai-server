import { Router } from 'express';
import { z } from 'zod';
import { logError, logEvent } from '../observability/logger';
import { bearer } from '../auth/middleware';
import { getAuthConfig, login, updateAuthConfig, verifyToken } from '../auth/service';

// Local auth for Nicole's dashboard. `/status` is open (the app calls it on boot
// to decide whether to show a login screen); `/login` mints a token; `/settings`
// flips the toggle + sets the password (protected once auth is on — see below).
export const authRouter = Router();

// GET /auth/status — is login required, and is a password configured yet?
authRouter.get('/status', async (_req, res) => {
  try {
    const cfg = await getAuthConfig(true);
    res.json({ enabled: cfg.enabled, configured: cfg.configured });
  } catch (err) {
    logError('auth.status', 'status failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /auth/login { password } -> { token }
const loginSchema = z.object({ password: z.string().min(1) });
authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'password required' });
  try {
    const token = await login(parsed.data.password);
    if (!token) return res.status(401).json({ error: 'invalid password' });
    logEvent('info', 'auth.login', 'dashboard login');
    return res.json({ token });
  } catch (err) {
    logError('auth.login', 'login failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// PUT /auth/settings { enabled?, password? } — change the toggle and/or password.
// Bootstrap-friendly: while auth is OFF anyone on Nicole's machine can turn it on
// and set the password; once it's ON, changing settings needs a valid token.
const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    password: z.string().min(6).optional(),
  })
  .refine((d) => d.enabled !== undefined || d.password !== undefined, {
    message: 'provide enabled and/or password',
  });

authRouter.put('/settings', async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  try {
    const current = await getAuthConfig(true);
    if (current.enabled && !verifyToken(bearer(req), current.tokenSecret)) {
      return res.status(401).json({ error: 'unauthorized', auth_required: true });
    }
    const next = await updateAuthConfig(parsed.data);
    logEvent('info', 'auth.settings', 'auth settings updated', { enabled: next.enabled, configured: next.configured });
    return res.json({ enabled: next.enabled, configured: next.configured });
  } catch (err) {
    if (err instanceof Error && err.message.includes('password')) {
      return res.status(400).json({ error: err.message });
    }
    logError('auth.settings', 'update failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
