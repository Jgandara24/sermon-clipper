import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageLimitExceededError, type StorageProvider } from "./types";

type S3StorageProviderOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
};

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageProviderOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
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

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`S3 object ${key} has no response body.`);
    }
    await pipeline(toNodeReadable(result.Body), createWriteStream(destinationPath));
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
}

function toNodeReadable(body: unknown): NodeJS.ReadableStream {
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
