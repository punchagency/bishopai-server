import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, issueToken, verifyToken } from './service';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('salts — same password hashes differently each time', () => {
    expect(hashPassword('samepw')).not.toBe(hashPassword('samepw'));
  });

  it('rejects against a null or malformed hash', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', 'not-a-valid-format')).toBe(false);
  });
});

describe('session tokens', () => {
  const secret = 'a'.repeat(64);

  it('accepts a freshly issued token with the right secret', () => {
    expect(verifyToken(issueToken(secret), secret)).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    expect(verifyToken(issueToken(secret), 'b'.repeat(64))).toBe(false);
  });

  it('rejects an expired token', () => {
    expect(verifyToken(issueToken(secret, -1000), secret)).toBe(false);
  });

  it('rejects tampered / malformed tokens and a null secret', () => {
    const t = issueToken(secret);
    expect(verifyToken(`${t}x`, secret)).toBe(false);
    expect(verifyToken('garbage', secret)).toBe(false);
    expect(verifyToken(undefined, secret)).toBe(false);
    expect(verifyToken(t, null)).toBe(false);
  });
});
