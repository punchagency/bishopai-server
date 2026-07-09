// Practice Better integration — OAuth2 client + reads + webhook management.
// Gated on beta access (Open Item #1); everything throws a clear error until
// PB_CLIENT_ID / PB_CLIENT_SECRET are set.
export { isPbConfigured, pbConfig } from './config';
export { pbRequest, resetPbToken } from './client';
export * from './reads';
export * from './dispensary';
export * from './readiness';
export * from './webhooks';
export type * from './types';
