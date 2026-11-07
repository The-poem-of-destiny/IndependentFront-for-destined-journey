/** Wire contract shared with the independently deployed Discord content pack server. */
export interface EncryptedPackEnvelope {
  formatVersion: 1;
  packId: string;
  packVersion: string;
  minEngineVersion?: string;
  name?: string;
  boundUserId: string;
  issuedAt: number;
  expiresAt: number;
  wrapNonceB64: string;
  wrappedDekB64: string;
  bodyNonceB64: string;
  ciphertextB64: string;
  plainSha256: string;
}

export interface PackKeyLease {
  packId: string;
  packVersion: string;
  boundUserId: string;
  distributedKeyB64: string;
  issuedAt: number;
  expiresAt: number;
}

interface DiscordAccess {
  eligible: boolean;
  code: string;
  guildId: string;
  message: string;
  inviteUrl?: string;
}

export interface DiscordAuthSession {
  token: string;
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
  access: DiscordAccess;
  expiresAt: number;
  verifiedAt: number;
  serverUrl: string;
}

export type PackLeaseState =
  | 'LOCAL'
  | 'ACTIVE_UNLOCKED'
  | 'RENEWING'
  | 'LOCKED_NOT_LOGGED_IN'
  | 'LOCKED_ACCOUNT_MISMATCH'
  | 'LOCKED_EXPIRED'
  | 'LOCKED_REVOKED'
  | 'LOCKED_CORRUPT'
  | 'LOCKED_LEGACY';

export type PackRenewal = Pick<
  EncryptedPackEnvelope,
  | 'packId'
  | 'packVersion'
  | 'boundUserId'
  | 'issuedAt'
  | 'expiresAt'
  | 'wrapNonceB64'
  | 'wrappedDekB64'
>;

export interface ProtectedPackDownload {
  envelope: EncryptedPackEnvelope;
  keyLease: PackKeyLease;
}
