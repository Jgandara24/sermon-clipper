import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyLocalModel, type LocalModelDescriptor } from "@/lib/media/local-models";

let root: string, modelRoot: string;
const bytes = Buffer.from("fixture model bytes, not executable weights");
const descriptor: LocalModelDescriptor = {
  modelId: "fixture", version: "v1", roles: ["FACE_DETECTION"], relativePath: "fixture/model.bin",
  sha256: createHash("sha256").update(bytes).digest("hex"), byteCount: bytes.length,
  upstreamRevision: "fixture-revision", sourceUrl: "https://example.test/model",
  license: { spdx: "MIT", codeEvidenceUrl: "https://example.test/code-license", weightsEvidenceUrl: "https://example.test/weights-license",
    reviewStatus: "REVIEWED_FOR_EVALUATION", reviewReference: "fixture-license-review" },
  productionApproval: { approved: false, evaluationEvidenceSha256: null, decisionReference: null },
};
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "local-models-"));
  modelRoot = path.join(root, "models");
  await mkdir(path.join(modelRoot, "fixture"), { recursive: true });
  await writeFile(path.join(modelRoot, descriptor.relativePath), bytes);
});
afterEach(async () => rm(root, { recursive: true, force: true }));
const options = () => ({ modelRoot, usage: "evaluation" as const });

describe("mounted local model verification", () => {
  it("verifies bytes and returns model provenance without activating production", async () => {
    expect(await verifyLocalModel(descriptor, options())).toMatchObject({ modelId: "fixture", version: "v1",
      sha256: descriptor.sha256, byteCount: bytes.length, usage: "evaluation", licenseSpdx: "MIT" });
  });
  it.each(["UNREVIEWED", "REJECTED"] as const)("refuses %s license status", async reviewStatus => {
    await expect(verifyLocalModel({ ...descriptor, license: { ...descriptor.license, reviewStatus } }, options()))
      .rejects.toThrow("LOCAL_MODEL_LICENSE_REVIEW_REQUIRED");
  });
  it("refuses production without both a mounted volume and approval evidence", async () => {
    await expect(verifyLocalModel(descriptor, { modelRoot, usage: "production" })).rejects.toThrow("PRODUCTION_VOLUME_REQUIRED");
    await expect(verifyLocalModel(descriptor, { modelRoot: "/models", usage: "production" })).rejects.toThrow("PRODUCTION_APPROVAL_REQUIRED");
    await expect(verifyLocalModel({ ...descriptor, productionApproval: { approved: true, evaluationEvidenceSha256: null,
      decisionReference: "fixture-decision" } }, { modelRoot: "/models", usage: "production" })).rejects.toThrow("PRODUCTION_APPROVAL_REQUIRED");
  });
  it("rejects changed bytes and wrong file sizes", async () => {
    await writeFile(path.join(modelRoot, descriptor.relativePath), Buffer.alloc(bytes.length, 120));
    await expect(verifyLocalModel(descriptor, options())).rejects.toThrow("CHECKSUM_MISMATCH");
    await writeFile(path.join(modelRoot, descriptor.relativePath), "short");
    await expect(verifyLocalModel(descriptor, options())).rejects.toThrow("BYTE_COUNT_MISMATCH");
  });
  it.each(["../outside.bin", "/tmp/outside.bin", "fixture/../outside.bin", "fixture\\outside.bin"])("rejects unconfined path %s", async relativePath => {
    await expect(verifyLocalModel({ ...descriptor, relativePath }, options())).rejects.toThrow();
  });
  it("rejects direct symlinks and parent-directory escapes", async () => {
    const external = path.join(root, "external");
    await mkdir(external);
    await writeFile(path.join(external, "model.bin"), bytes);
    await symlink(path.join(external, "model.bin"), path.join(modelRoot, "linked.bin"));
    await expect(verifyLocalModel({ ...descriptor, relativePath: "linked.bin" }, options())).rejects.toThrow("REGULAR_FILE_REQUIRED");
    await symlink(external, path.join(modelRoot, "linked-directory"));
    await expect(verifyLocalModel({ ...descriptor, relativePath: "linked-directory/model.bin" }, options())).rejects.toThrow("PATH_ESCAPES_VOLUME");
  });
  it("does not download or substitute a missing model", async () => {
    await rm(path.join(modelRoot, descriptor.relativePath));
    await expect(verifyLocalModel(descriptor, options())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
