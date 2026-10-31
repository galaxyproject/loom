/**
 * Authenticated encryption for what the host keeps that must not be readable if leaked: refresh
 * tokens at rest (brief decision 8) and the short-lived sign-in state cookie. AES-256-GCM with the
 * ORBIT_TOKEN_KEY; the sealed form is iv || tag || ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV = 12;
const TAG = 16;

export function seal(key: Buffer, plain: string, purpose: string): Buffer {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // The purpose is bound in, so a sealed refresh token can't be replayed as a sign-in state and back.
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** The plaintext, or undefined when the box was tampered with, sealed for another purpose or key. */
export function unseal(key: Buffer, sealed: Buffer, purpose: string): string | undefined {
  if (sealed.length < IV + TAG) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(sealed.subarray(IV, IV + TAG));
    return Buffer.concat([decipher.update(sealed.subarray(IV + TAG)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}
