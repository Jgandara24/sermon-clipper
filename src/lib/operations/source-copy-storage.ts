import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { S3Client, HeadObjectCommand, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { SourceCopyRefused, type CopyStorage, type ObjectIdentity } from "./source-copy";

/** Narrow storage adapter: bounded reads and conditional copy only. No delete/move method. */
export class SourceCopyS3Storage implements CopyStorage {
  readonly identity: string;
  constructor(private readonly client: S3Client, private readonly bucket: string,
    private readonly kind: "aws" | "r2", backend: string) {
    this.identity = createHash("sha256").update(`${kind}:${backend}:${bucket}`).digest("hex");
  }
  async inspect(key: string, maxBytes: number): Promise<ObjectIdentity | null> {
    const signal = AbortSignal.timeout(60_000);
    let head;
    try { head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal }); }
    catch (e) {
      if (e && typeof e === "object" && "$metadata" in e &&
        (e.$metadata as { httpStatusCode?: number }).httpStatusCode === 404) return null;
      throw e;
    }
    const bytes = head.ContentLength;
    if (!bytes || bytes > maxBytes || !head.ETag) throw new SourceCopyRefused("OBJECT_SIZE_OR_IDENTITY");
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key,
      IfMatch: head.ETag, VersionId: head.VersionId }), { abortSignal: signal });
    if (!result.Body) throw new SourceCopyRefused("OBJECT_BODY_MISSING");
    const hash = createHash("sha256");
    const body = result.Body;
    if (!(body instanceof Readable)) throw new SourceCopyRefused("UNSUPPORTED_BODY_STREAM");
    // SDK request completion does not by itself bound consumption of the response stream.
    const abort = () => body.destroy(new SourceCopyRefused("OBJECT_READ_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let count = 0;
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        count += chunk.byteLength;
        if (count > maxBytes || count > bytes) throw new SourceCopyRefused("OBJECT_TOO_LARGE");
        hash.update(chunk);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      body.destroy();
    }
    const after = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    if (count !== bytes || after.ContentLength !== bytes || after.ETag !== head.ETag ||
      after.VersionId !== head.VersionId || after.LastModified?.valueOf() !== head.LastModified?.valueOf() ||
      after.Metadata?.["copy-operation"] !== head.Metadata?.["copy-operation"]) {
      throw new SourceCopyRefused("OBJECT_CHANGED_DURING_READ");
    }
    return { bytes, etag: head.ETag, sha256: hash.digest("hex"), owner: head.Metadata?.["copy-operation"] ?? null,
      versionId: head.VersionId ?? null, lastModified: head.LastModified?.toISOString() ?? null };
  }
  async copy(source: string, destination: string, etag: string, operationId: string) {
    const command = new CopyObjectCommand({ Bucket: this.bucket, Key: destination,
      CopySource: `${this.bucket}/${source.split("/").map(encodeURIComponent).join("/")}`,
      CopySourceIfMatch: etag, ...(this.kind === "aws" ? { IfNoneMatch: "*" } : {}),
      MetadataDirective: "REPLACE", Metadata: { "copy-operation": operationId }, ContentType: "video/mp4" });
    // R2's documented destination precondition is different from Amazon S3's.
    if (this.kind === "r2") command.middlewareStack.add(next => async args => {
      const request = args.request as { headers: Record<string, string> };
      request.headers["cf-copy-destination-if-none-match"] = "*";
      return next(args);
    }, { step: "build", name: "copyDestinationMustNotExist" });
    await this.client.send(command, { abortSignal: AbortSignal.timeout(60_000) });
  }
}
export function sourceCopyStorageFromEnv(env: NodeJS.ProcessEnv) {
  const bucket = env.STORAGE_S3_BUCKET, accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID,
    secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY, endpoint = env.STORAGE_S3_ENDPOINT;
  if (!bucket || !accessKeyId || !secretAccessKey) throw new SourceCopyRefused("S3_CONFIG_MISSING");
  const url = endpoint ? new URL(endpoint) : null;
  if (url && (url.protocol !== "https:" || url.username || url.password || url.search ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) || url.pathname !== "/")) {
    throw new SourceCopyRefused("STORAGE_CONTRACT_UNSUPPORTED");
  }
  const kind = url ? "r2" : "aws";
  return new SourceCopyS3Storage(new S3Client({ endpoint, region: env.STORAGE_S3_REGION ?? (url ? "auto" : "us-east-1"),
    maxAttempts: 1, credentials: { accessKeyId, secretAccessKey } }), bucket, kind,
  endpoint ?? `aws:${env.STORAGE_S3_REGION ?? "us-east-1"}`);
}
