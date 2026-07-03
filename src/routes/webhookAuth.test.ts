import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { requireWebhookSecret, requirePbSignature, parsePbSignature } from './webhookAuth';

// Minimal Express req/res doubles: `get` reads a header, `status().json()` captures the response.
function fakeReq(headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (name: string) => lower[name.toLowerCase()],
    originalUrl: '/webhooks/test',
  } as unknown as Request;
}

// PB request double: a raw body + a PB-Signature header.
function pbReq(sig: string | undefined, rawBody: Buffer): Request {
  return {
    get: (name: string) => (name.toLowerCase() === 'pb-signature' ? sig : undefined),
    originalUrl: '/webhooks/pb/session',
    rawBody,
  } as unknown as Request;
}

function pbSign(secret: string, t: number, rawBody: Buffer): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return `t=${t},v1=${v1}`;
}

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response['status'];
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res as Response;
  }) as unknown as Response['json'];
  return res as Response & { statusCode?: number; body?: unknown };
}

const SECRET = 's3cret-value';

describe('requireWebhookSecret', () => {
  it('fails open (calls next) when the env var is unset', () => {
    delete process.env.WH_TEST_UNSET;
    const mw = requireWebhookSecret('WH_TEST_UNSET');
    const next = vi.fn();
    const res = fakeRes();
    mw(fakeReq(), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts the correct secret via X-Webhook-Secret', () => {
    process.env.WH_TEST_SET = SECRET;
    const mw = requireWebhookSecret('WH_TEST_SET');
    const next = vi.fn();
    const res = fakeRes();
    mw(fakeReq({ 'X-Webhook-Secret': SECRET }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts the correct secret via Authorization: Bearer', () => {
    process.env.WH_TEST_SET = SECRET;
    const mw = requireWebhookSecret('WH_TEST_SET');
    const next = vi.fn();
    const res = fakeRes();
    mw(fakeReq({ Authorization: `Bearer ${SECRET}` }), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a wrong secret with 401 and does not call next', () => {
    process.env.WH_TEST_SET = SECRET;
    const mw = requireWebhookSecret('WH_TEST_SET');
    const next = vi.fn();
    const res = fakeRes();
    mw(fakeReq({ 'X-Webhook-Secret': 'wrong' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a missing secret with 401', () => {
    process.env.WH_TEST_SET = SECRET;
    const mw = requireWebhookSecret('WH_TEST_SET');
    const next = vi.fn();
    const res = fakeRes();
    mw(fakeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('parsePbSignature', () => {
  it('parses t and v1 in any order', () => {
    expect(parsePbSignature('t=123,v1=abcd')).toEqual({ t: 123, v1: 'abcd' });
    expect(parsePbSignature('v1=abcd, t=123')).toEqual({ t: 123, v1: 'abcd' });
  });
  it('rejects malformed input', () => {
    expect(parsePbSignature('t=123')).toBeNull();
    expect(parsePbSignature('t=123,v1=nothex!')).toBeNull();
    expect(parsePbSignature('')).toBeNull();
  });
});

describe('requirePbSignature', () => {
  const PB = 'pb-signing-secret';
  const body = Buffer.from(JSON.stringify({ eventType: 'session.updated', id: 'sess-1' }));

  it('accepts a valid, fresh signature', () => {
    process.env.PB_TEST = PB;
    const mw = requirePbSignature('PB_TEST');
    const next = vi.fn();
    const res = fakeRes();
    mw(pbReq(pbSign(PB, Math.floor(Date.now() / 1000), body), body), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a tampered body', () => {
    process.env.PB_TEST = PB;
    const mw = requirePbSignature('PB_TEST');
    const next = vi.fn();
    const res = fakeRes();
    const sig = pbSign(PB, Math.floor(Date.now() / 1000), body);
    mw(pbReq(sig, Buffer.from('{"eventType":"session.updated","id":"HACKED"}')), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp (replay)', () => {
    process.env.PB_TEST = PB;
    const mw = requirePbSignature('PB_TEST');
    const next = vi.fn();
    const res = fakeRes();
    const old = Math.floor(Date.now() / 1000) - 1000; // > 5 min
    mw(pbReq(pbSign(PB, old, body), body), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing signature header', () => {
    process.env.PB_TEST = PB;
    const mw = requirePbSignature('PB_TEST');
    const next = vi.fn();
    const res = fakeRes();
    mw(pbReq(undefined, body), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('fails open when the signing secret is unset', () => {
    delete process.env.PB_TEST_UNSET;
    const mw = requirePbSignature('PB_TEST_UNSET');
    const next = vi.fn();
    const res = fakeRes();
    mw(pbReq(undefined, body), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
