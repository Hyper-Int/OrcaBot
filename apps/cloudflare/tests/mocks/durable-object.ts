/**
 * Mock Durable Object for testing
 */

export class MockDurableObjectState implements DurableObjectState {
  private _storage = new Map<string, unknown>();
  private webSockets: WebSocket[] = [];

  id: DurableObjectId = {
    toString: () => 'mock-do-id',
    equals: (other: DurableObjectId) => other.toString() === 'mock-do-id',
    name: 'mock-do',
  };

  waitUntil(promise: Promise<unknown>): void {
    // No-op in tests
  }

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  acceptWebSocket(ws: WebSocket): void {
    this.webSockets.push(ws);
  }

  getWebSockets(): WebSocket[] {
    return this.webSockets;
  }

  setWebSocketAutoResponse(maybeReqResp?: WebSocketRequestResponsePair): void {
    // No-op in tests
  }

  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
    return null;
  }

  getWebSocketAutoResponseTimestamp(): Date | null {
    return null;
  }

  setHibernatableWebSocketEventTimeout(timeout?: number): void {
    // No-op in tests
  }

  getHibernatableWebSocketEventTimeout(): number | null {
    return null;
  }

  getTags(ws: WebSocket): string[] {
    return [];
  }

  abort(reason?: string): never {
    throw new Error(reason || 'Aborted');
  }

  get storage(): DurableObjectStorage {
    const storageMap = this._storage;
    return {
      get: async <T>(key: string) => storageMap.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { storageMap.set(key, value); },
      delete: async (key: string) => storageMap.delete(key),
      list: async () => new Map(storageMap),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      sync: async () => {},
      transaction: async <T>(closure: (txn: DurableObjectTransaction) => Promise<T>) => {
        return closure(storageMap as unknown as DurableObjectTransaction);
      },
      deleteAll: async () => { storageMap.clear(); },
      getCurrentBookmark: async () => '',
      getBookmarkForTime: async () => '',
      onNextSessionRestoreBookmark: async () => '',
    } as DurableObjectStorage;
  }
}

export class MockDurableObjectNamespace implements DurableObjectNamespace {
  private instances = new Map<string, DurableObjectStub>();
  private DOClass: new (state: DurableObjectState) => DurableObject;

  constructor(DOClass: new (state: DurableObjectState) => DurableObject) {
    this.DOClass = DOClass;
  }

  idFromName(name: string): DurableObjectId {
    return {
      toString: () => `id-${name}`,
      equals: (other: DurableObjectId) => other.toString() === `id-${name}`,
      name,
    };
  }

  idFromString(id: string): DurableObjectId {
    return {
      toString: () => id,
      equals: (other: DurableObjectId) => other.toString() === id,
    };
  }

  newUniqueId(): DurableObjectId {
    const id = `unique-${Date.now()}-${Math.random()}`;
    return {
      toString: () => id,
      equals: (other: DurableObjectId) => other.toString() === id,
    };
  }

  get(id: DurableObjectId): DurableObjectStub {
    const key = id.toString();
    if (!this.instances.has(key)) {
      const state = new MockDurableObjectState();
      const instance = new this.DOClass(state);
      const stub: DurableObjectStub = {
        id,
        name: id.name,
        fetch: (input: RequestInfo, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          return instance.fetch(request);
        },
        connect: () => { throw new Error('Not implemented'); },
      };
      this.instances.set(key, stub);
    }
    return this.instances.get(key)!;
  }

  jurisdiction(jurisdiction: DurableObjectJurisdiction): DurableObjectNamespace {
    return this;
  }
}
