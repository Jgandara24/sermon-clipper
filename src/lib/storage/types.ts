export interface StorageProvider {
  /** Absolute filesystem path for a storage key. Only meaningful to local-disk-style providers. */
  absolutePath(key: string): string;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  writeFromWebStream(key: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<number>;
  move(fromKey: string, toKey: string): Promise<void>;
  remove(key: string): Promise<void>;
  readAsBuffer(key: string): Promise<Buffer>;
}

export class StorageLimitExceededError extends Error {}
