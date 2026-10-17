import type { MultipartStorage } from "./multipart";

export type StorageObjectListing = { key: string; lastModified: Date };

export type StorageObjectIdentity = {
  token: string;
  byteCount: number;
  etag?: string;
  versionId?: string;
  sha256?: string;
};

export type StorageDownloadResult = {
  transferredBytes: number;
  cacheState: "hit" | "miss" | "not_applicable";
};

export class StorageDownloadError extends Error {
  constructor(cause: unknown, readonly download?: StorageDownloadResult) {
    super(cause instanceof Error ? cause.message : "Storage materialization failed.", { cause });
  }
}

export interface StorageProvider {
  /** Optional direct browser upload capability. Local storage keeps the relay path. */
  multipart?: MultipartStorage;
  /** Stable identity for the bucket or local root, without credentials. */
  getStorageIdentity?(): string;
  /** Absolute filesystem path for a storage key. Only meaningful to local-disk-style providers. */
  absolutePath(key: string): string;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  writeFromWebStream(key: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<number>;
  getObjectIdentity?(key: string): Promise<StorageObjectIdentity | null>;
  downloadToFile(key: string, destinationPath: string, expected?: StorageObjectIdentity): Promise<void | StorageDownloadResult>;
  uploadFile(key: string, sourcePath: string, contentType?: string): Promise<void>;
  /** Atomically creates a new object. Never replaces an existing object or retries unconditionally.
   * Provider size limits apply; this capability does not imply multipart support. */
  uploadFileIfAbsent?(key: string, sourcePath: string, contentType?: string): Promise<void>;
  createSignedReadUrl?(
    key: string,
    options: { expiresInSeconds: number; contentType?: string; filename?: string | null; disposition?: "inline" | "attachment" },
  ): Promise<string>;
  move(fromKey: string, toKey: string): Promise<void>;
  /**
   * Every object under a key prefix, with when it was last written. Used by retention to find
   * objects no database row points at — an abandoned upload leaves no row to scan from.
   */
  list(prefix: string): Promise<StorageObjectListing[]>;
  remove(key: string): Promise<void>;
  readAsBuffer(key: string): Promise<Buffer>;
  /**
   * The inclusive byte range `[start, end]` of an object. Shorter than asked when the object ends
   * first, and empty when it starts past the end — the same shape as an HTTP 206.
   */
  readRange(key: string, start: number, end: number): Promise<Buffer>;
}

export class StorageLimitExceededError extends Error {}
