import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { SourceCopyS3Storage, sourceCopyStorageFromEnv } from "@/lib/operations/source-copy-storage";
import { copyInputSchema } from "@/lib/operations/source-copy";

function client() { return new S3Client({ region: "us-east-1", maxAttempts: 1,
  credentials: { accessKeyId: "fixture-only", secretAccessKey: "fixture-only" } }); }
const bytes = Buffer.from("fixture bytes");
const head = { ContentLength: bytes.length, ETag: '"fixture"', LastModified: new Date("2026-05-20"), Metadata: {} };
describe("bounded copy storage contract", () => {
  it("hashes actual bytes with a source precondition and before/after identity checks", async () => {
    const c = client();
    const send = vi.spyOn(c, "send").mockImplementationOnce(async () => head).mockImplementationOnce(async () => ({ Body: Readable.from([bytes]) })).mockImplementationOnce(async () => head);
    const storage = new SourceCopyS3Storage(c, "fixture", "aws", "fixture");
    await expect(storage.inspect("source", 100)).resolves.toEqual({ bytes: bytes.length, etag: '"fixture"', owner: null, versionId: null, lastModified: head.LastModified.toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(send.mock.calls[1][0].input).toMatchObject({ IfMatch: '"fixture"' });
  });
  it("refuses oversized objects before reading any bytes", async () => {
    const c = client(), send = vi.spyOn(c, "send").mockImplementationOnce(async () => head);
    await expect(new SourceCopyS3Storage(c, "fixture", "aws", "fixture").inspect("source", 1)).rejects.toThrow("OBJECT_SIZE");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["overflow", "short", "changed"])("refuses %s reads", async mode => {
    const c = client();
    const body = Readable.from([mode === "overflow" ? Buffer.alloc(101) : mode === "short" ? Buffer.from("x") : bytes]);
    vi.spyOn(c, "send").mockImplementationOnce(async () => head).mockImplementationOnce(async () => ({ Body: body }))
      .mockImplementationOnce(async () => mode === "changed" ? { ...head, ETag: "different" } : head);
    await expect(new SourceCopyS3Storage(c, "fixture", "aws", "fixture").inspect("source", 100)).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });
  it("distinguishes missing objects from denied reads", async () => {
    const c = client(); vi.spyOn(c, "send").mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 403 } });
    const storage = new SourceCopyS3Storage(c, "fixture", "aws", "fixture");
    expect(await storage.inspect("missing", 100)).toBeNull();
    await expect(storage.inspect("denied", 100)).rejects.toBeDefined();
  });
  it("terminates a stalled response body when its deadline expires", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const c = client(), body = new Readable({ read() {} });
    vi.spyOn(c, "send").mockImplementationOnce(async () => head)
      .mockImplementationOnce(async () => ({ Body: body }));
    try {
      const reading = new SourceCopyS3Storage(c, "fixture", "aws", "fixture").inspect("source", 100);
      const rejected = expect(reading).rejects.toThrow("OBJECT_READ_TIMEOUT");
      await vi.waitFor(() => expect(body.listenerCount("error")).toBeGreaterThan(0));
      controller.abort();
      await rejected;
      expect(body.destroyed).toBe(true);
    } finally { timeout.mockRestore(); body.destroy(); }
  });
  it.each(["aws", "r2"] as const)("sends source and destination conditions for %s without a network call", async kind => {
    let headers: Record<string, string> = {};
    const c = new S3Client({ region: "us-east-1", maxAttempts: 1,
      credentials: { accessKeyId: "fixture-only", secretAccessKey: "fixture-only" },
      requestHandler: { async handle(request: { headers: Record<string, string> }) {
        headers = request.headers;
        return { response: { statusCode: 200, headers: { "content-type": "application/xml" },
          body: Readable.from(['<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>']) } };
      } } });
    const operationId = randomUUID();
    await new SourceCopyS3Storage(c, "fixture", kind, "fixture").copy("source/a b", "dest", '"original"', operationId);
    expect(headers["x-amz-copy-source-if-match"]).toBe('"original"');
    expect(headers[kind === "r2" ? "cf-copy-destination-if-none-match" : "if-none-match"]).toBe("*");
    expect(headers["x-amz-copy-source"]).toBe("fixture/source/a%20b");
    expect(headers["x-amz-meta-copy-operation"]).toBe(operationId);
  });
  it("refuses unknown storage endpoints without connecting", () => {
    expect(() => sourceCopyStorageFromEnv({ NODE_ENV: "test", STORAGE_S3_BUCKET: "fixture", STORAGE_S3_ACCESS_KEY_ID: "fixture",
      STORAGE_S3_SECRET_ACCESS_KEY: "fixture", STORAGE_S3_ENDPOINT: "https://unknown.example" })).toThrow("STORAGE_CONTRACT_UNSUPPORTED");
  });
  it("requires a real calendar date, explicit occurrence, and bounded byte count", () => {
    const input = { operatorId: randomUUID(), importUserId: randomUUID(), projectId: randomUUID(), workspaceId: randomUUID(),
      sermonDate: "2026-05-20", occurrence: "UNMATCHED", maxBytes: 100 };
    expect(copyInputSchema.parse(input)).toEqual(input);
    for (const patch of [{ sermonDate: "2026-02-30" }, { occurrence: undefined }, { maxBytes: 500_000_001 }]) {
      expect(() => copyInputSchema.parse({ ...input, ...patch })).toThrow();
    }
  });
});
