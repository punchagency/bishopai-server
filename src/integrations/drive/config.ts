// Google Drive connection config. OAuth2 with a stored refresh token from
// Nicole's Google account (authorized once); the backend mints access tokens
// from it. Set via env once Google OAuth is done (Open Item #7).
export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
  /** Optional parent folder that client folders are created under. */
  rootFolderId?: string;
}

export function isDriveConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

export function driveConfig(): DriveConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Drive not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  }
  return {
    clientId,
    clientSecret,
    refreshToken,
    tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    rootFolderId: process.env.GDRIVE_ROOT_FOLDER_ID || undefined,
  };
}
