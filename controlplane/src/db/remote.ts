// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Remote D1 adapter for desktop mode.
 *
 * workerd does not provide a D1 binding, so this adapter talks to a local
 * HTTP shim backed by SQLite.
 */

import type { Env } from '../types';

let didLogRemoteD1 = false;

type D1QueryPayload = {
  sql: string;
  params: unknown[];
};

class RemoteD1Client {
  private baseUrl: string;
  private fetcher?: Fetcher;
  private debug: boolean;

  constructor(baseUrl: string, fetcher?: Fetcher, debug = false) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetcher = fetcher;
    this.debug = debug;
  }

  async query<T>(payload: D1QueryPayload): Promise<D1Result<T>> {
    return this.request<D1Result<T>>('/query', payload);
  }

  async batch<T>(payload: D1QueryPayload[]): Promise<D1Result<T>[]> {
    return this.request<D1Result<T>[]>('/batch', { statements: payload });
  }

  async exec(payload: { sql: string }): Promise<D1ExecResult> {
    return this.request<D1ExecResult>('/exec', payload);
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    if (this.debug) {
      console.log(`[d1-shim] POST ${url}`, {
        useFetcher: Boolean(this.fetcher),
      });
    }

    const request = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const response = this.fetcher ? await this.fetcher.fetch(request) : await fetch(request);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`D1 shim error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }
}

class RemoteD1PreparedStatement {
  private bindings: unknown[] = [];

  constructor(
    private client: RemoteD1Client,
    private sql: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.bindings = values;
    return this as unknown as D1PreparedStatement;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const result = await this.all<T>();
    const row = result.results[0] ?? null;
    if (colName && row) {
      return (row as Record<string, unknown>)[colName] as T;
    }
    return row as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.client.query<T>({ sql: this.sql, params: this.bindings });
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<unknown[]> {
    const result = await this.all();
    const rows = result.results.map(row => Object.values(row as Record<string, unknown>)) as T[];
    if (options?.columnNames) {
      const firstRow = result.results[0] as Record<string, unknown> | undefined;
      const colNames = firstRow ? Object.keys(firstRow) : [];
      return [colNames, ...rows];
    }
    return rows;
  }

  toPayload(): D1QueryPayload {
    return { sql: this.sql, params: this.bindings };
  }
}

function isRemoteStatement(
  statement: D1PreparedStatement
): boolean {
  return typeof (statement as unknown as RemoteD1PreparedStatement).toPayload === 'function';
}

class RemoteD1Database {
  private client: RemoteD1Client;

  constructor(baseUrl: string, fetcher?: Fetcher, debug = false) {
    this.client = new RemoteD1Client(baseUrl, fetcher, debug);
  }

  prepare(query: string): D1PreparedStatement {
    return new RemoteD1PreparedStatement(this.client, query) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const payload = statements.map(statement => {
      if (!isRemoteStatement(statement)) {
        throw new Error('D1 shim batch requires statements from the same database instance.');
      }
      return (statement as unknown as RemoteD1PreparedStatement).toPayload();
    });

    return this.client.batch<T>(payload);
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.client.exec({ sql: query });
  }

  withSession(token?: string): D1Database {
    // Session pinning not supported in desktop mode; return self
    return this as unknown as D1Database;
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('D1 dump not supported in desktop mode.');
  }
}

export type EnvWithDb = Env & { DB: D1Database };

export function ensureDb(env: Env): EnvWithDb {
  const existing = (env as { DB?: D1Database }).DB;
  if (existing) {
    return env as EnvWithDb;
  }

  if (!env.D1_HTTP_URL) {
    throw new Error('D1 binding missing and D1_HTTP_URL not set.');
  }

  if (env.D1_SHIM_DEBUG === 'true' && !didLogRemoteD1) {
    console.log('[d1-shim] using remote D1', {
      url: env.D1_HTTP_URL,
      hasFetcher: Boolean(env.D1_SHIM),
    });
    didLogRemoteD1 = true;
  }

  return {
    ...env,
    DB: new RemoteD1Database(
      env.D1_HTTP_URL,
      env.D1_SHIM,
      env.D1_SHIM_DEBUG === 'trace'
    ) as unknown as D1Database,
  };
}
