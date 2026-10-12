// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, afterEach, vi } from 'vitest';
import { executeGitHubAction } from './api-clients/github';

describe('GitHub client encodes each path segment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps spaces, # and ? inside the filename', async () => {
    const fetchMock = vi.fn<[RequestInfo | URL], Promise<Response>>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await executeGitHubAction('github.get_file', { owner: 'o', repo: 'r', path: 'docs/Getting Started #1?.md', ref: 'main' }, 'tok');
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/repos/o/r/contents/docs/Getting%20Started%20%231%3F.md');
    expect(url.searchParams.get('ref')).toBe('main');
  });
});
