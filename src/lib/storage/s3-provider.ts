import type { MultipartRequestMeasurement } from "./multipart-measurement";
import { S3MultipartStorage } from "./s3-multipart";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { exactByteCount } from "./file-identity";
import {
  StorageLimitExceededError,
  type StorageObjectListing,
  type StorageProvider,
  type StorageObjectIdentity,
} from "./types";

type S3StorageProviderOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  onMultipartRequest?: (measurement: MultipartRequestMeasurement) => Promise<void>;
};

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  readonly multipart: S3MultipartStorage;

  constructor(private readonly options: S3StorageProviderOptions) {
    const clientOptions = {
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    };
    this.client = new S3Client(clientOptions);
    // The browser supplies part bytes later. Do not sign a checksum of an absent request body.
    this.multipart = new S3MultipartStorage(new S3Client({
      ...clientOptions, requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 1,
    }), options.bucket, options.onMultipartRequest);
  }

  getStorageIdentity(): string {
    const endpoint = this.options.endpoint ? new URL(this.options.endpoint).toString().replace(/\/$/, "") : "aws";
    return createHash("sha256").update(JSON.stringify(["s3-storage-v1", endpoint, this.options.region, this.options.bucket])).digest("hex");
  }

  absolutePath(key: string): string {
    throw new Error(`S3 object ${key} does not have a stable local filesystem path.`);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  async size(key: string): Promise<number> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    return result.ContentLength ?? 0;
  }

  async writeFromWebStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): Promise<number> {
    let bytesWritten = 0;
    const limitedStream = Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>).pipe(
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            callback(new StorageLimitExceededError(`Upload exceeded ${maxBytes} byte limit.`));
            return;
          }
          callback(null, chunk);
        },
      }),
    );

    await new Upload({
      client: this.client,
      params: {
        Bucket: this.options.bucket,
        Key: key,
        Body: limitedStream,
      },
    }).done();

    return bytesWritten;
  }

  async getObjectIdentity(key: string): Promise<StorageObjectIdentity | null> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (!result.ETag || !Number.isSafeInteger(result.ContentLength) || result.ContentLength! < 0) return null;
    return {
      token: JSON.stringify([result.ETag, result.VersionId ?? null, result.ContentLength]),
      byteCount: result.ContentLength!, etag: result.ETag, versionId: result.VersionId,
    };
  }

  async downloadToFile(key: string, destinationPath: string, expected?: StorageObjectIdentity): Promise<void> {
    if (expected && !expected.etag) throw new Error("A conditional S3 download requires an ETag.");
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key,
        IfMatch: expected?.etag, VersionId: expected?.versionId }),
    );
    if (!result.Body) {
      throw new Error(`S3 object ${key} has no response body.`);
    }
    const body = toNodeReadable(result.Body);
    if (expected && (result.ETag !== expected.etag ||
        (expected.versionId !== undefined && result.VersionId !== expected.versionId))) {
      body.destroy();
      throw new Error("S3 response does not match the requested object identity.");
    }
    try {
      if (expected) {
        await pipeline(body, exactByteCount(expected.byteCount), createWriteStream(destinationPath));
      } else await pipeline(body, createWriteStream(destinationPath));
    } catch (error) {
      await rm(destinationPath, { force: true });
      throw error;
    }
  }

  async uploadFile(key: string, sourcePath: string, contentType?: string): Promise<void> {
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.options.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentType: contentType,
      },
    }).done();
  }

  async uploadFileIfAbsent(key: string, sourcePath: string, contentType?: string): Promise<void> {
    const facts = await stat(sourcePath);
    if (!facts.isFile()) throw new Error("Conditional upload requires a regular file.");
    const body = createReadStream(sourcePath);
    try {
      // R2 documents atomic conditions for PutObject. Do not use multipart here:
      // CompleteMultipartUpload needs a separate provider capability proof.
      await this.client.send(new PutObjectCommand({
        Bucket: this.options.bucket, Key: key, Body: body,
        ContentLength: facts.size, ContentType: contentType, IfNoneMatch: "*",
      }));
    } finally {
      body.destroy();
    }
  }

  async createSignedReadUrl(
    key: string,
    options: {
      expiresInSeconds: number;
      contentType?: string;
      filename?: string | null;
      disposition?: "inline" | "attachment";
    },
  ): Promise<string> {
    const filename = options.filename?.replace(/"/g, "");
    const disposition = filename
      ? `${options.disposition ?? "inline"}; filename="${filename}"`
      : options.disposition;

    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        CopySource: `${this.options.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
        Key: toKey,
      }),
    );
    await this.remove(fromKey);
  }

  /** Pages through the prefix; S3 caps a single response at 1000 keys. */
  async list(prefix: string): Promise<StorageObjectListing[]> {
    const out: StorageObjectListing[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) {
          out.push({ key: object.Key, lastModified: object.LastModified ?? new Date(0) });
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async readAsBuffer(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`S3 object ${key} has no response body.`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of toNodeReadable(result.Body)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async readRange(key: string, start: number, end: number): Promise<Buffer> {
    let result;
    try {
      result = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key, Range: `bytes=${start}-${end}` }),
      );
    } catch (error) {
      // A range that starts past the end is not an error here, any more than it is for a file.
      if ((error as { name?: string }).name === "InvalidRange") return Buffer.alloc(0);
      throw error;
    }
    if (!result.Body) {
      throw new Error(`S3 object ${key} has no response body.`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of toNodeReadable(result.Body)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    return Readable.fromWeb(
      (body as { transformToWebStream: () => NodeWebReadableStream<Uint8Array> }).transformToWebStream(),
    );
  }
  throw new Error("Unsupported S3 response body type.");
}

function isNotFoundError(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
