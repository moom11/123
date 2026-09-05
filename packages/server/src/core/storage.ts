import { config } from './config.js';

/**
 * Attachment storage.
 *
 * Invoice photographs are the only binary the system stores. On a Node host
 * they go to a directory; on Cloudflare Workers there is no filesystem, so the
 * Worker installs an R2-backed implementation. Callers only ever see a storage
 * key, which is what the attachments table records.
 */
export interface AttachmentStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

class FilesystemStore implements AttachmentStore {
  async put(key: string, data: Uint8Array): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const path = join(config.uploads.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      return new Uint8Array(await readFile(join(config.uploads.dir, key)));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await unlink(join(config.uploads.dir, key)).catch(() => {});
  }
}

let store: AttachmentStore = new FilesystemStore();

export function setAttachmentStore(next: AttachmentStore): void {
  store = next;
}

export function attachments(): AttachmentStore {
  return store;
}
