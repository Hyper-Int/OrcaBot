/**
 * Mock D1 Database for testing
 */

interface Row {
  [key: string]: unknown;
}

export class MockD1Database {
  private tables: Map<string, Row[]> = new Map();
  private lastInsertId = 0;

  // For testing: access to internal state
  _tables = this.tables;

  // Seed data for testing
  seed(tableName: string, rows: Row[]): void {
    this.tables.set(tableName, [...rows]);
  }

  clear(): void {
    this.tables.clear();
    this.lastInsertId = 0;
  }

  prepare(query: string): D1PreparedStatement {
    return new MockD1PreparedStatement(query, this.tables, () => ++this.lastInsertId) as unknown as D1PreparedStatement;
  }

  withSession(_token?: string): D1Database {
    return this as unknown as D1Database;
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('Not implemented in mock');
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map(s => (s as unknown as MockD1PreparedStatement).all<T>()));
  }

  exec(query: string): Promise<D1ExecResult> {
    // Simple exec for schema creation
    const statements = query.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      const trimmed = stmt.trim().toUpperCase();
      if (trimmed.startsWith('CREATE TABLE')) {
        const match = stmt.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
        if (match) {
          const tableName = match[1];
          if (!this.tables.has(tableName)) {
            this.tables.set(tableName, []);
          }
        }
      }
    }
    return Promise.resolve({ count: statements.length, duration: 0 });
  }
}

class MockD1PreparedStatement {
  private query: string;
  private tables: Map<string, Row[]>;
  private bindings: unknown[] = [];
  private getNextId: () => number;

  constructor(query: string, tables: Map<string, Row[]>, getNextId: () => number) {
    this.query = query;
    this.tables = tables;
    this.getNextId = getNextId;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.bindings = values;
    return this as unknown as D1PreparedStatement;
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const results = await this.all<T>();
    const row = results.results[0] || null;
    if (colName && row) {
      return (row as Row)[colName] as T;
    }
    return row;
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    const result = this.execute<T>();
    return {
      results: result,
      success: true,
      meta: {
        duration: 0,
        last_row_id: this.lastInsertId || 0,
        changes: this.changes || 0,
        served_by: 'mock',
        internal_stats: null,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        changed_db: false,
      },
    };
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const results = await this.all();
    return results.results.map(row => Object.values(row as Row)) as T[];
  }

  private lastInsertId = 0;
  private changes = 0;

  private execute<T>(): T[] {
    const query = this.query.trim().toUpperCase();

    if (query.startsWith('SELECT')) {
      return this.executeSelect<T>();
    } else if (query.startsWith('INSERT')) {
      return this.executeInsert<T>();
    } else if (query.startsWith('UPDATE')) {
      return this.executeUpdate<T>();
    } else if (query.startsWith('DELETE')) {
      return this.executeDelete<T>();
    } else if (query.startsWith('CREATE')) {
      return [] as T[];
    }

    return [] as T[];
  }

  private executeSelect<T>(): T[] {
    // Parse table name from query
    const tableMatch = this.query.match(/FROM\s+(\w+)/i);
    if (!tableMatch) return [];

    const tableName = tableMatch[1];
    let rows = this.tables.get(tableName) || [];

    // Handle JOINs
    const joinMatch = this.query.match(/JOIN\s+(\w+)\s+\w+\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i);
    if (joinMatch) {
      const joinTable = joinMatch[1];
      const joinRows = this.tables.get(joinTable) || [];
      const leftTable = joinMatch[2];
      const leftCol = joinMatch[3];
      const rightTable = joinMatch[4];
      const rightCol = joinMatch[5];

      rows = rows.flatMap(row => {
        const matchingJoins = joinRows.filter(jr => {
          const leftVal = leftTable === tableName ? row[leftCol] : jr[leftCol];
          const rightVal = rightTable === tableName ? row[rightCol] : jr[rightCol];
          return leftVal === rightVal;
        });
        return matchingJoins.map(jr => ({ ...row, ...jr }));
      });
    }

    // Handle WHERE clause
    const whereMatch = this.query.match(/WHERE\s+(.+?)(?:ORDER|LIMIT|$)/i);
    if (whereMatch) {
      const conditions = this.parseWhereClause(whereMatch[1]);
      rows = rows.filter(row => this.matchesConditions(row, conditions));
    }

    // Handle ORDER BY
    const orderMatch = this.query.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
    if (orderMatch) {
      const orderCol = orderMatch[1];
      const desc = orderMatch[2]?.toUpperCase() === 'DESC';
      rows = [...rows].sort((a, b) => {
        const aVal = a[orderCol];
        const bVal = b[orderCol];
        if ((aVal as number | string) < (bVal as number | string)) return desc ? 1 : -1;
        if ((aVal as number | string) > (bVal as number | string)) return desc ? -1 : 1;
        return 0;
      });
    }

    return rows as T[];
  }

  private executeInsert<T>(): T[] {
    const tableMatch = this.query.match(/INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+(\w+)/i);
    if (!tableMatch) return [];

    const tableName = tableMatch[1];
    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, []);
    }

    const colMatch = this.query.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colMatch) return [];

    const columns = colMatch[1].split(',').map(c => c.trim());
    const row: Row = {};

    // VALUES may mix `?` with literals ('' / 'started' / datetime('now')).
    const valuesStart = this.query.search(/VALUES\s*\(/i);
    const values = splitTopLevel(this.query.slice(this.query.indexOf('(', valuesStart) + 1, matchingParen(this.query, this.query.indexOf('(', valuesStart))));
    let bindingIndex = 0;
    columns.forEach((col, i) => {
      const expr = values[i]?.trim() ?? '?';
      row[col] = expr === '?' ? this.bindings[bindingIndex++] : literalValue(expr);
    });

    const isIgnore = /INSERT\s+OR\s+IGNORE/i.test(this.query);
    const upsert = this.query.match(/ON\s+CONFLICT\s*\((\w+)\)\s*DO\s+(NOTHING|UPDATE\s+SET\s+([\s\S]+?))(?:\s+WHERE\s+([\s\S]+?))?\s*$/i);
    const conflictKey = upsert ? upsert[1] : columns[0];
    const existing = (isIgnore || upsert) && columns.length > 0
      ? this.tables.get(tableName)!.find(r => r[conflictKey] === row[conflictKey])
      : undefined;
    if (existing) {
      this.changes = 0;
      if (!upsert || /^NOTHING$/i.test(upsert[2])) return [] as T[];
      // `WHERE table.col = 'literal'` guards the update (a no-op if it fails).
      if (upsert[4]) {
        const guard = upsert[4].match(/(?:\w+\.)?(\w+)\s*=\s*('(?:[^']|'')*')/);
        if (guard && existing[guard[1]] !== literalValue(guard[2])) return [] as T[];
      }
      for (const part of splitTopLevel(upsert[3])) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const col = part.slice(0, eq).trim();
        const expr = part.slice(eq + 1).trim();
        const excluded = expr.match(/^excluded\.(\w+)$/i);
        existing[col] = excluded ? row[excluded[1]] : expr === '?' ? this.bindings[bindingIndex++] : literalValue(expr);
      }
      this.changes = 1;
      return [] as T[];
    }

    this.tables.get(tableName)!.push(row);
    this.lastInsertId = this.getNextId();
    this.changes = 1;

    return [] as T[];
  }

  private executeUpdate<T>(): T[] {
    const tableMatch = this.query.match(/UPDATE\s+(\w+)/i);
    if (!tableMatch) return [];

    const tableName = tableMatch[1];
    const rows = this.tables.get(tableName) || [];

    // Parse SET clause (handle multi-line queries)
    const setMatch = this.query.match(/SET\s+([\s\S]+?)\s+WHERE/i);
    if (!setMatch) return [];

    const setParts = setMatch[1].split(',').map(s => s.trim());
    const updates: Record<string, unknown> = {};
    let bindingIndex = 0;

    for (const part of setParts) {
      const eqIndex = part.indexOf('=');
      if (eqIndex === -1) continue;
      const col = part.substring(0, eqIndex).trim();

      // Handle COALESCE(?, col) pattern
      if (part.includes('COALESCE')) {
        const value = this.bindings[bindingIndex++];
        if (value !== null) {
          updates[col] = value;
        }
      } else if (/^'(?:[^']|'')*'$/.test(part.substring(eqIndex + 1).trim())) {
        updates[col] = literalValue(part.substring(eqIndex + 1).trim());
      } else {
        updates[col] = this.bindings[bindingIndex++];
      }
    }

    // Parse WHERE (handle multi-line and trailing whitespace)
    const whereMatch = this.query.match(/WHERE\s+([\s\S]+?)$/i);
    if (whereMatch) {
      const whereClause = whereMatch[1].trim();
      const conditions = this.parseWhereClause(whereClause, bindingIndex);
      let count = 0;
      for (const row of rows) {
        if (this.matchesConditions(row, conditions)) {
          Object.assign(row, updates);
          count++;
        }
      }
      this.changes = count;
    }

    return [] as T[];
  }

  private executeDelete<T>(): T[] {
    const tableMatch = this.query.match(/DELETE FROM\s+(\w+)/i);
    if (!tableMatch) return [];

    const tableName = tableMatch[1];
    const rows = this.tables.get(tableName) || [];

    const whereMatch = this.query.match(/WHERE\s+([\s\S]+?)$/i);
    if (whereMatch) {
      const conditions = this.parseWhereClause(whereMatch[1]);
      const newRows = rows.filter(row => !this.matchesConditions(row, conditions));
      this.changes = rows.length - newRows.length;
      this.tables.set(tableName, newRows);
    }

    return [] as T[];
  }

  private parseWhereClause(clause: string, startIndex = 0): Array<{ col: string; op: string; bindingIndex: number }> {
    const conditions: Array<{ col: string; op: string; bindingIndex: number }> = [];
    const parts = clause.split(/\s+AND\s+/i);
    let bindingIndex = startIndex;

    for (const part of parts) {
      const match = part.match(/(\w+(?:\.\w+)?)\s*(=|!=|<|>|<=|>=|IN|LIKE)\s*\?/i);
      if (match) {
        const col = match[1].includes('.') ? match[1].split('.')[1] : match[1];
        conditions.push({ col, op: match[2].toUpperCase(), bindingIndex });
        bindingIndex++;
      }
    }

    return conditions;
  }

  private matchesConditions(row: Row, conditions: Array<{ col: string; op: string; bindingIndex: number }>): boolean {
    return conditions.every(cond => {
      const rowVal = row[cond.col];
      const bindVal = this.bindings[cond.bindingIndex];

      switch (cond.op) {
        case '=': return rowVal === bindVal;
        case '!=': return rowVal !== bindVal;
        case '<': return (rowVal as number) < (bindVal as number);
        case '>': return (rowVal as number) > (bindVal as number);
        case '<=': return (rowVal as number) <= (bindVal as number);
        case '>=': return (rowVal as number) >= (bindVal as number);
        case 'IN': return Array.isArray(bindVal) && bindVal.includes(rowVal);
        case 'LIKE': {
          const pattern = (bindVal as string).replace(/%/g, '.*');
          return new RegExp(`^${pattern}$`, 'i').test(rowVal as string);
        }
        default: return false;
      }
    });
  }
}

/** Splits a SQL list on commas outside parentheses and quotes. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function matchingParen(sql: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "'") quoted = !quoted;
    if (quoted) continue;
    if (sql[i] === '(') depth++;
    if (sql[i] === ')' && --depth === 0) return i;
  }
  return sql.length;
}

/** A SQL literal as the mock stores it: strings unquoted, datetime('now') as an ISO time. */
function literalValue(expr: string): unknown {
  const str = expr.match(/^'((?:[^']|'')*)'$/);
  if (str) return str[1].replace(/''/g, "'");
  if (/^datetime\('now'\)$/i.test(expr)) return new Date().toISOString();
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if (/^NULL$/i.test(expr)) return null;
  return expr;
}
