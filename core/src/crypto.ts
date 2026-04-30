// packages/core/src/crypto.ts
import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

/**
 * Derives a shared key from a pairing code and host ID using PBKDF2.
 * Returns a hex string.
 */
export function deriveSharedKey(pairingCode: string, hostId: string): string {
  return pbkdf2Sync(pairingCode, hostId, 100000, 32, 'sha256').toString('hex');
}

/**
 * Computes an auth hash from a shared key hex string.
 * Used for switchboard verification.
 */
export function computeAuthHash(sharedKey: string): string {
  return createHash('sha256').update(sharedKey).digest('hex');
}

/**
 * Computes an HMAC-SHA256 signature over a payload.
 */
export function computeHMAC(sharedKey: string, payload: unknown): string {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const keyBuffer = Buffer.from(sharedKey, 'hex');
  return createHmac('sha256', keyBuffer).update(data).digest('hex');
}

/**
 * Verifies an HMAC signature using timing-safe comparison.
 */
export function verifyHMAC(sharedKey: string, payload: unknown, signature: string): boolean {
  const expected = computeHMAC(sharedKey, payload);
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);

  if (expectedBuf.length !== signatureBuf.length) return false;
  return timingSafeEqual(expectedBuf, signatureBuf);
}