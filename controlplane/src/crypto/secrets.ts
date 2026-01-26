// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Secrets Encryption Utilities
 *
 * AES-256-GCM encryption for user secrets stored in D1.
 * Format: base64(iv):base64(ciphertext)
 */

import type { Env } from '../types';

// Cache imported CryptoKey to avoid re-importing on every request
let cachedKey: CryptoKey | null = null;
let cachedKeySource: string | null = null;

/**
 * Import a base64-encoded 256-bit key as a CryptoKey for AES-GCM.
 */
async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  if (keyBytes.length !== 32) {
    throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes (256 bits)');
  }
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Get or create the CryptoKey from env.
 * Caches the imported key for performance within a single request context.
 */
export async function getEncryptionKey(env: Env): Promise<CryptoKey> {
  const keySource = env.SECRETS_ENCRYPTION_KEY;
  if (!keySource) {
    throw new Error('SECRETS_ENCRYPTION_KEY not configured');
  }

  // Return cached key if source hasn't changed
  if (cachedKey && cachedKeySource === keySource) {
    return cachedKey;
  }

  cachedKey = await importEncryptionKey(keySource);
  cachedKeySource = keySource;
  return cachedKey;
}

/**
 * Check if encryption key is configured.
 */
export function hasEncryptionKey(env: Env): boolean {
  return !!env.SECRETS_ENCRYPTION_KEY;
}

/**
 * Encrypt a plaintext secret value.
 * Returns format: "base64(iv):base64(ciphertext)"
 */
export async function encryptSecret(
  plaintext: string,
  key: CryptoKey
): Promise<string> {
  // Generate random 12-byte IV (required for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encode plaintext as UTF-8
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // Encrypt with AES-GCM
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintextBytes
  );

  // Convert to base64
  const ivBase64 = btoa(String.fromCharCode(...iv));
  const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));

  return `${ivBase64}:${ciphertextBase64}`;
}

/**
 * Decrypt an encrypted secret value.
 * Input format: "base64(iv):base64(ciphertext)"
 */
export async function decryptSecret(
  encrypted: string,
  key: CryptoKey
): Promise<string> {
  const colonIndex = encrypted.indexOf(':');
  if (colonIndex === -1) {
    throw new Error('Invalid encrypted format: missing IV separator');
  }

  const ivBase64 = encrypted.substring(0, colonIndex);
  const ciphertextBase64 = encrypted.substring(colonIndex + 1);

  // Decode from base64
  const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ciphertextBase64), c => c.charCodeAt(0));

  if (iv.length !== 12) {
    throw new Error('Invalid IV length');
  }

  // Decrypt with AES-GCM
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  // Decode UTF-8
  const decoder = new TextDecoder();
  return decoder.decode(plaintextBuffer);
}

/**
 * Check if a value appears to be encrypted (contains : separator with valid base64).
 * Used to detect already-encrypted values during migration.
 */
export function isEncryptedValue(value: string): boolean {
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) {
    return false;
  }

  const part1 = value.substring(0, colonIndex);
  const part2 = value.substring(colonIndex + 1);

  // Check both parts are valid base64 and IV is correct length (16 chars = 12 bytes)
  if (part1.length !== 16) {
    return false;
  }

  try {
    atob(part1);
    atob(part2);
    return true;
  } catch {
    return false;
  }
}
