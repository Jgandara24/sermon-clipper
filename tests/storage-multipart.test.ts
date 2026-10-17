import type { MultipartRequestMeasurement } from "@/lib/storage/multipart-measurement";
import { createServer } from "node:http";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3MultipartStorage } from "@/lib/storage/s3-multipart";
import { S3StorageProvider } from "@/lib/storage/s3-provider";
import {
  MULTIPART_MIN_PART_BYTES as partBytes, MULTIPART_MAX_PART_BYTES, MULTIPART_MAX_BYTES,
  multipartPartBytes, validateMultipartPlan,
} from "@/lib/storage/multipart";

const session = { key: "tmp/workspace/session", sessionId: "11111111-1111-4111-8111-111111111111",
  totalBytes: partBytes + 3, partBytes, uploadId: "provider-upload-id" };
const remoteParts = [{ PartNumber: 1, Size: partBytes, ETag: '"first"' }, { PartNumber: 2, Size: 3, ETag: '"last"' }];
const head = { ETag: '"complete"', ContentLength: session.totalBytes,
  Metadata: { "upload-session": session.sessionId, "upload-byte-count": String(session.totalBytes) } };
function fixture(record?: (measurement: MultipartRequestMeasurement) => Promise<void>) {
  const client = new S3Client({ region: "auto", endpoint: "https://storage.example.test", forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED", credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" } });
  const send = vi.fn<(command: { input: unknown }) => Promise<Record<string, unknown>>>();
  Object.defineProperty(client, "send", { value: send });
  return { send, multipart: new S3MultipartStorage(client, "fixture", record) };
}
afterEach(() => vi.restoreAllMocks());

describe("multipart upload layout", () => {
  it("uses equal parts and one exact final remainder", () => {
    expect(validateMultipartPlan(session)).toBe(2);
    expect(multipartPartBytes(session, 1)).toBe(partBytes);
    expect(multipartPartBytes(session, 2)).toBe(3);
    expect(multipartPartBytes({ ...session, totalBytes: 3 }, 1)).toBe(3);
    expect(validateMultipartPlan({ ...session, totalBytes: partBytes * 10_000 })).toBe(10_000);
  });
  it.each([
    { totalBytes: 0 }, { totalBytes: -1 }, { totalBytes: 1.5 }, { totalBytes: MULTIPART_MAX_BYTES + 1 },
    { partBytes: partBytes - 1 }, { partBytes: MULTIPART_MAX_PART_BYTES + 1 },
    { totalBytes: partBytes * 10_000 + 1 }, { key: "" }, { sessionId: "not-a-session" },
  ])("refuses invalid upload layout %j", change => {
    expect(() => validateMultipartPlan({ ...session, ...change })).toThrow();
  });
  it.each([0, -1, 1.5, 3, NaN])("refuses unplanned part %s", number => {
    expect(() => multipartPartBytes(session, number)).toThrow("MULTIPART_INVALID_PART_NUMBER");
  });
});

describe("S3 multipart control operations", () => {
  it("inspects completed ownership without a mutation", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValue(head);
    expect(await multipart.inspectCompleted(session)).toEqual({ etag: head.ETag, byteCount: session.totalBytes });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].constructor.name).toBe("HeadObjectCommand");
  });
  it.each(["NotFound", "NoSuchKey"])("recognizes an absent object (%s)", async name => {
    const { send, multipart } = fixture();
    send.mockRejectedValue(Object.assign(new Error("absent"), { name }));
    expect(await multipart.inspectCompleted(session)).toBeNull();
  });
  it.each([{ ...head, ContentLength: 2 }, { ...head, ETag: undefined }, { ...head, Metadata: {} }])(
    "refuses mismatched completion evidence %#", async response => {
      const { send, multipart } = fixture();
      send.mockResolvedValue(response);
      await expect(multipart.inspectCompleted(session)).rejects.toThrow("OBJECT_MISMATCH");
    });
  it("does not interpret inspection failures as absence", async () => {
    const { send, multipart } = fixture();
    send.mockRejectedValue(new Error("AccessDenied"));
    await expect(multipart.inspectCompleted(session)).rejects.toThrow("AccessDenied");
  });
  it("finds one exact-key initiation without creating another upload", async () => {
    const { send, multipart } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error("absent"), { name: "NotFound" }))
      .mockResolvedValueOnce({ Uploads: [{ Key: session.key + "-other", UploadId: "unrelated" },
        { Key: session.key, UploadId: "recovered" }] });
    expect(await multipart.findInitiated(session)).toEqual({ uploadId: "recovered" });
    expect(send.mock.calls[1][0].input).toEqual({ Bucket: "fixture", Prefix: session.key, MaxUploads: 1000 });
    expect(send.mock.calls.map(call => call[0].constructor.name)).toEqual(["HeadObjectCommand", "ListMultipartUploadsCommand"]);
  });
  it("keeps missing initiation uncertain", async () => {
    const { send, multipart } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error("absent"), { name: "NotFound" })).mockResolvedValueOnce({ Uploads: [] });
    expect(await multipart.findInitiated(session)).toBeNull();
  });
  it.each([
    { Uploads: [{ Key: session.key, UploadId: "one" }, { Key: session.key, UploadId: "two" }] },
    { Uploads: [{ Key: session.key }] },
    { Uploads: [{ Key: session.key, UploadId: "one" }], IsTruncated: true },
  ])("refuses ambiguous initiation evidence %#", async result => {
    const { send, multipart } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error("absent"), { name: "NotFound" })).mockResolvedValueOnce(result);
    await expect(multipart.findInitiated(session)).rejects.toThrow("INITIATION_AMBIGUOUS");
  });
  it("does not adopt an unfinished upload when a completed object exists", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce(head);
    await expect(multipart.findInitiated(session)).rejects.toThrow("INITIATION_OBJECT_PRESENT");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("records each control request without recording browser transfers", async () => {
    const measurements: MultipartRequestMeasurement[] = [];
    const { send, multipart } = fixture(async measurement => { measurements.push(measurement); });
    send.mockResolvedValueOnce({ Parts: [remoteParts[0]], IsTruncated: true, NextPartNumberMarker: "1", $metadata: { httpStatusCode: 200 } })
      .mockResolvedValueOnce({ Parts: [remoteParts[1]], $metadata: { httpStatusCode: 200 } })
      .mockResolvedValueOnce({ ETag: head.ETag, $metadata: { httpStatusCode: 200 } })
      .mockResolvedValueOnce({ ...head, $metadata: { httpStatusCode: 200 } });
    await multipart.complete(session);
    expect(measurements.map(value => value.operation)).toEqual(["ListParts", "ListParts", "CompleteMultipartUpload", "HeadObject"]);
    expect(new Set(measurements.map(value => value.requestId)).size).toBe(4);
    for (const measurement of measurements) {
      expect(measurement).toMatchObject({ sessionId: session.sessionId, storageKey: session.key, httpStatus: 200, outcome: "succeeded" });
      expect(measurement.wallTimeMs).toBeGreaterThanOrEqual(0);
    }
    await multipart.signPart(session, 1, 60);
    expect(measurements).toHaveLength(4);
  });
  it("records failed requests without copying provider error details", async () => {
    const record = vi.fn<(measurement: MultipartRequestMeasurement) => Promise<void>>().mockResolvedValue();
    const { send, multipart } = fixture(record);
    send.mockRejectedValue(Object.assign(new Error("private provider response"), { $metadata: { httpStatusCode: 503 } }));
    await expect(multipart.create(session)).rejects.toThrow("private provider response");
    expect(record.mock.calls[0][0]).toMatchObject({ operation: "CreateMultipartUpload", httpStatus: 503, outcome: "failed" });
    expect(JSON.stringify(record.mock.calls)).not.toContain("private provider response");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not repeat or fail a provider operation when its measurement fails", async () => {
    const { send, multipart } = fixture(async () => { throw new Error("measurement failure"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockResolvedValueOnce({ UploadId: "one" });
    expect(await multipart.create(session)).toEqual({ uploadId: "one" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
  it("binds initiated uploads to a durable session and declared size", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValue({ UploadId: session.uploadId });
    expect(await multipart.create(session)).toEqual({ uploadId: session.uploadId });
    expect(send.mock.calls[0][0].input).toMatchObject({ Key: session.key, Bucket: "fixture", Metadata: head.Metadata });
  });
  it("does not silently recreate an upload after an uncertain response", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValue({});
    await expect(multipart.create(session)).rejects.toThrow("MULTIPART_CREATE_UNCERTAIN");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not let the SDK repeat an uncertain create request", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(503, { "Content-Type": "application/xml" });
      response.end("<Error><Code>ServiceUnavailable</Code><Message>fixture</Message></Error>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture server has no port.");
      const provider = new S3StorageProvider({ bucket: "fixture", region: "auto",
        endpoint: `http://127.0.0.1:${address.port}`, accessKeyId: "fixture", secretAccessKey: "fixture" });
      await expect(provider.multipart.create(session)).rejects.toThrow("fixture");
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it("signs exact part bytes, target, and expiry without a checksum for an empty body", async () => {
    const provider = new S3StorageProvider({ bucket: "fixture", region: "auto", endpoint: "https://storage.example.test",
      accessKeyId: "fixture", secretAccessKey: "fixture" });
    const url = new URL(await provider.multipart.signPart(session, 2, 60));
    expect(url.pathname).toBe("/fixture/tmp/workspace/session");
    expect(url.searchParams.get("uploadId")).toBe(session.uploadId);
    expect(url.searchParams.get("partNumber")).toBe("2");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain("content-length");
    expect([...url.searchParams.keys()].some(key => key.toLowerCase().startsWith("x-amz-checksum-"))).toBe(false);
  });
  it.each([0, 3601, 1.5])("rejects invalid signature expiry %s", async expiry => {
    const { send, multipart } = fixture();
    await expect(multipart.signPart(session, 1, expiry)).rejects.toThrow("MULTIPART_INVALID_URL_EXPIRY");
    expect(send).not.toHaveBeenCalled();
  });
  it("uses storage ETags across pages and verifies the completed object", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({ Parts: [remoteParts[0]], IsTruncated: true, NextPartNumberMarker: "1" })
      .mockResolvedValueOnce({ Parts: [remoteParts[1]], IsTruncated: false })
      .mockResolvedValueOnce({ ETag: head.ETag }).mockResolvedValueOnce(head);
    expect(await multipart.complete(session)).toEqual({ etag: head.ETag, byteCount: session.totalBytes });
    expect(send.mock.calls[1][0].input).toMatchObject({ PartNumberMarker: "1", UploadId: session.uploadId });
    expect(send.mock.calls[2][0].input).toMatchObject({ MultipartUpload: {
      Parts: [{ PartNumber: 1, ETag: '"first"' }, { PartNumber: 2, ETag: '"last"' }],
    } });
  });
  it.each([
    [], [remoteParts[0]], [remoteParts[1]],
    [{ ...remoteParts[0], Size: partBytes + 1 }, remoteParts[1]],
    [{ ...remoteParts[0], ETag: undefined }, remoteParts[1]],
    [remoteParts[0], remoteParts[0]], [remoteParts[1], remoteParts[0]],
    [remoteParts[0], { ...remoteParts[1], PartNumber: 3 }],
  ].map(Parts => ({ Parts })))("refuses incomplete or changed remote parts %#", async ({ Parts }) => {
    const { send, multipart } = fixture();
    send.mockResolvedValue({ Parts });
    await expect(multipart.complete(session)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "0", "2", "NaN"])("rejects invalid pagination marker %s", async NextPartNumberMarker => {
    const { send, multipart } = fixture();
    send.mockResolvedValue({ Parts: [remoteParts[0]], IsTruncated: true, NextPartNumberMarker });
    await expect(multipart.listParts(session)).rejects.toThrow("MULTIPART_INVALID_PAGINATION");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...head, ETag: '"changed"' }, { ...head, ContentLength: 1 }, { ...head, Metadata: {} },
    { ...head, Metadata: { ...head.Metadata, "upload-session": "another-session" } },
  ])("retains uncertain completion for reconciliation %#", async object => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({ Parts: remoteParts }).mockResolvedValueOnce({ ETag: head.ETag }).mockResolvedValueOnce(object);
    await expect(multipart.complete(session)).rejects.toThrow("MULTIPART_COMPLETION_UNCERTAIN");
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("propagates uncertain completion without automatic deletion or retry", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({ Parts: remoteParts }).mockRejectedValueOnce(new Error("lost response"));
    await expect(multipart.complete(session)).rejects.toThrow("lost response");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("confirms cancellation with read-only absence checks", async () => {
    const { send, multipart } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchUpload" }))
      .mockRejectedValueOnce(Object.assign(new Error("absent"), { name: "NotFound" }));
    expect(await multipart.inspectAborted(session)).toBe(true);
    expect(send.mock.calls.map(call => call[0].constructor.name)).toEqual(["ListPartsCommand", "HeadObjectCommand"]);
  });
  it("does not treat an empty live upload as confirmed cancellation", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({ Parts: [] });
    expect(await multipart.inspectAborted(session)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps a completed object after an uncertain cancellation", async () => {
    const { send, multipart } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchUpload" })).mockResolvedValueOnce(head);
    expect(await multipart.inspectAborted(session)).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(["parts", "object"])("does not treat %s access failures as cancellation evidence", async stage => {
    const { send, multipart } = fixture();
    if (stage === "object") send.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchUpload" }));
    send.mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(multipart.inspectAborted(session)).rejects.toThrow("AccessDenied");
  });
  it("confirms empty parts and absent object after abort", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Parts: [], IsTruncated: false })
      .mockRejectedValueOnce(Object.assign(new Error("absent"), { name: "NotFound" }));
    await multipart.abort(session);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0].input).toMatchObject({ UploadId: session.uploadId, MaxParts: 1 });
  });
  it("does not report deletion when parts remain", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Parts: [remoteParts[0]] });
    await expect(multipart.abort(session)).rejects.toThrow("ABORT_UNCONFIRMED");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("preserves completed objects found after abort", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Parts: [] }).mockResolvedValueOnce(head);
    await expect(multipart.abort(session)).rejects.toThrow("ABORT_OBJECT_PRESENT");
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("does not treat access denial as proof of object removal", async () => {
    const { send, multipart } = fixture();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Parts: [] }).mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(multipart.abort(session)).rejects.toThrow("AccessDenied");
  });
  it("aborts only the exact upload and tolerates an already absent upload", async () => {
    const { send, multipart } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchUpload" }))
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchUpload" }))
      .mockRejectedValueOnce(Object.assign(new Error("absent"), { name: "NotFound" }));
    await multipart.abort(session);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: "fixture", Key: session.key, UploadId: session.uploadId });
    send.mockRejectedValueOnce(new Error("connection failed"));
    await expect(multipart.abort(session)).rejects.toThrow("connection failed");
  });
});
