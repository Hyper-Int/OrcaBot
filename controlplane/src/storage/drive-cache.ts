// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env } from '../types';

export class DesktopFeatureDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopFeatureDisabledError';
  }
}

const disabledError = new DesktopFeatureDisabledError(
  'Drive cache is not available in desktop mode.'
);

const disabledDriveCache = {
  async get(): Promise<never> {
    throw disabledError;
  },
  async put(): Promise<never> {
    throw disabledError;
  },
  async delete(): Promise<never> {
    throw disabledError;
  },
  async head(): Promise<never> {
    throw disabledError;
  },
  async createMultipartUpload(): Promise<never> {
    throw disabledError;
  },
} as unknown as R2Bucket;

export type EnvWithDriveCache = Env & { DRIVE_CACHE: R2Bucket };

export function ensureDriveCache(env: Env): EnvWithDriveCache {
  if (env.DRIVE_CACHE) {
    return env as EnvWithDriveCache;
  }

  return {
    ...env,
    DRIVE_CACHE: disabledDriveCache,
  };
}

export function isDesktopFeatureDisabledError(error: unknown): boolean {
  return error instanceof DesktopFeatureDisabledError ||
    (error instanceof Error && error.name === 'DesktopFeatureDisabledError');
}
