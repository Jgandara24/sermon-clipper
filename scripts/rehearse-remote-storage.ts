import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { S3Client, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetPublicAccessBlockCommand, GetBucketVersioningCommand } from "@aws-sdk/client-s3";
import { SourceCopyS3Storage } from "../src/lib/operations/source-copy-storage";
import { StorageBudget, storageContract } from "./lib/rehearsal-storage-contract";

type ApprovedConfig = {
  bucket: string; provider: "aws" | "r2"; region: string; endpoint?: string;
  accessKeyId: string; secretAccessKey: string;
  maxUsd: number; worstCaseUsd: number; priceEvidenceUrl: string;
  approvedNewPrivateBucket: true; approvedBucketScopedCredentials: true;
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--approved-config") throw new Error("Remote tests require --approved-config and a private local file.");
  if (existsSync(args[1] + ".result.json")) throw new Error("Review the existing result before using a fresh approved configuration file.");
  const info = lstatSync(args[1]);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("The approved configuration must be a private regular file (0600).");
  const config: ApprovedConfig = JSON.parse(readFileSync(args[1], "utf8"));
  if (!/^p2-rehearsal-[a-f0-9]{32}$/.test(config.bucket) || !["aws", "r2"].includes(config.provider) ||
    config.approvedNewPrivateBucket !== true || config.approvedBucketScopedCredentials !== true ||
    !config.accessKeyId || !config.secretAccessKey || !/^https:\/\//.test(config.priceEvidenceUrl)) throw new Error("Reviewed bucket, credential scope, and price evidence are required.");
  if (!/^[a-z0-9-]+$/.test(config.region)) throw new Error("Invalid region.");
  const endpoint = config.provider === "aws" ? `https://s3.${config.region}.amazonaws.com` : config.endpoint;
  if (!endpoint) throw new Error("R2 endpoint is required.");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
      (config.provider === "r2" && !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname))) throw new Error("Storage endpoint refused.");
  const budget = new StorageBudget(config.maxUsd, config.worstCaseUsd);
  let cleanup = false;
  const client = new S3Client({ endpoint, region: config.region, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  client.middlewareStack.add(next => async request => {
    budget.request(cleanup);
    return next(request);
  }, { name: "rehearsalRequestLimit", step: "finalizeRequest", priority: "high" });
  const owned = new Map<string, string>();
  const evidence: Record<string, unknown> = { status: "RUNNING", provider: config.provider, bucket: config.bucket,
    approvedMaxUsd: config.maxUsd, estimatedWorstCaseUsd: config.worstCaseUsd, priceEvidenceUrl: config.priceEvidenceUrl,
    limits: ["Credential scope is user-attested, not discovered through account-wide IAM access.", "No database or processing run. Application registration recovery uses separate local evidence."] };
  try {
    const existing = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }));
    if (existing.KeyCount || existing.Contents?.length) throw new Error("Remote bucket must be empty.");
    if (config.provider === "aws") {
      const block = (await client.send(new GetPublicAccessBlockCommand({ Bucket: config.bucket }))).PublicAccessBlockConfiguration;
      if (!block?.BlockPublicAcls || !block.BlockPublicPolicy || !block.IgnorePublicAcls || !block.RestrictPublicBuckets) throw new Error("Bucket public access is not fully blocked.");
      const versions = await client.send(new GetBucketVersioningCommand({ Bucket: config.bucket }));
      if (versions.Status) throw new Error("Use a new unversioned disposable bucket.");
    } else evidence.privacyLimit = "R2 bucket privacy and disabled public domain require the reviewed configuration attestation.";
    const storage = new SourceCopyS3Storage(client, config.bucket, config.provider, endpoint);
    const recordKey = (key: string) => {
      const match = /^p2-rehearsal\/([a-f0-9-]{36})\/[a-z]+\.bin$/.exec(key);
      if (!match || (!owned.has(key) && owned.size >= 12)) throw new Error("Unowned key or object limit.");
      owned.set(key, match[1]);
    };
    evidence.contract = await storageContract({
      storage: { identity: storage.identity, inspect: (key, maxBytes) => storage.inspect(key, maxBytes),
        async copy(source, destination, etag, owner) {
          if (!owned.has(source)) throw new Error("Source is not owned.");
          recordKey(destination); budget.write(1024);
          await storage.copy(source, destination, etag, owner);
        } },
      async putOwned(key, bytes) {
        const known = owned.has(key); recordKey(key); budget.write(bytes.length);
        await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes,
          ...(!known ? { IfNoneMatch: "*" } : {}), Metadata: { "copy-operation": owned.get(key)! } }));
      },
    });
    evidence.status = "PASS";
  } catch (error) {
    evidence.status = "FAIL";
    // SDK error bodies can contain credentials or request details. Keep only the class name.
    evidence.errorType = error instanceof Error ? error.name : "UnknownError";
    process.exitCode = 1;
  } finally {
    cleanup = true;
    const cleanupResults: { key: string; status: string }[] = [];
    for (const [key, owner] of owned) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        if (head.Metadata?.["copy-operation"] !== owner || !head.ETag) throw new Error("Object ownership differs.");
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key, IfMatch: head.ETag }));
        cleanupResults.push({ key, status: "DELETED" });
      } catch (error) {
        const code = error && typeof error === "object" && "$metadata" in error ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode : undefined;
        cleanupResults.push({ key, status: code === 404 ? "ABSENT" : "BLOCKED — retain for manual review" });
        if (code !== 404) { evidence.status = "FAIL"; process.exitCode = 1; }
      }
    }
    evidence.cleanup = cleanupResults;
    evidence.requests = budget.requests; evidence.bytesWrittenUpperBound = budget.bytesWritten;
    client.destroy();
    // Store beside the private reviewed input; never print keys or credentials.
    writeFileSync(args[1] + ".result.json", JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Remote storage result: ${evidence.status}. See the private result file.`);
  }
}
main().catch(() => { console.error("Remote storage preflight failed. No approval is inferred from this command."); process.exitCode = 1; });
