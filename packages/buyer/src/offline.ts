/**
 * Offline store and sync queue.
 *
 * The purchasing rep works in warehouses, car parks and loading bays where the
 * signal comes and goes. Two rules shape this layer:
 *
 *   1. Approved requests are cached locally so the rep can always see what to
 *      buy. Nothing unapproved is ever cached, because nothing unapproved is
 *      ever fetched.
 *   2. Actions taken offline are queued and replayed in order once the
 *      connection returns. Every queued action carries a client-generated
 *      reference, and the server de-duplicates on it — so a replay after a
 *      timeout cannot record the same purchase twice.
 */

const DB_NAME = 'mara-buyer';
const DB_VERSION = 1;

export type StoreName = 'requests' | 'queue' | 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('requests')) {
        db.createObjectStore('requests', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'clientRef' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx<T>(
  store: StoreName, mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = fn(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putAll(store: StoreName, rows: any[]): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    const objectStore = transaction.objectStore(store);
    objectStore.clear();
    for (const row of rows) objectStore.put(row);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getAll<T = any>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await tx('meta', 'readwrite', (s) => s.put({ key, value }) as IDBRequest<any>);
}

export async function getMeta<T = unknown>(key: string): Promise<T | null> {
  const row = await tx<any>('meta', 'readonly', (s) => s.get(key));
  return (row?.value ?? null) as T | null;
}

/** An action taken while offline, waiting to be replayed. */
export interface QueuedAction {
  clientRef: string;
  kind: 'status' | 'purchase' | 'change_request';
  requestId: string;
  body: unknown;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export async function enqueue(action: Omit<QueuedAction, 'attempts' | 'createdAt'>): Promise<void> {
  await tx('queue', 'readwrite', (s) => s.put({
    ...action, attempts: 0, createdAt: new Date().toISOString(),
  }) as IDBRequest<any>);
}

export async function queued(): Promise<QueuedAction[]> {
  const rows = await getAll<QueuedAction>('queue');
  // Replay in the order the rep performed them: a purchase recorded before a
  // status change must reach the server in that order.
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function dequeue(clientRef: string): Promise<void> {
  await tx('queue', 'readwrite', (s) => s.delete(clientRef) as IDBRequest<any>);
}

export async function markAttempt(action: QueuedAction, error: string): Promise<void> {
  await tx('queue', 'readwrite', (s) => s.put({
    ...action, attempts: action.attempts + 1, lastError: error,
  }) as IDBRequest<any>);
}

export function newClientRef(): string {
  return `buyer-${crypto.randomUUID()}`;
}
