import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fileIdentity } from "@/lib/storage/file-identity";
import { sha256Schema } from "@/lib/media-artifacts/types";

const httpsUrl = z.string().url().refine(value => new URL(value).protocol === "https:", "Use an HTTPS evidence URL.");
const relativeModelPath = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value =>
  value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Use a confined model path.");

/** A runtime descriptor is stricter than a research candidate. Missing hashes or license evidence cannot load. */
export const localModelDescriptorSchema = z.object({
  modelId: z.string().min(1), version: z.string().min(1),
  roles: z.array(z.enum(["PERSON_DETECTION", "FACE_DETECTION", "OCR", "SPEECH_MUSIC", "AUDIO_EVENTS", "BOUNDARY_ASR"])).min(1),
  relativePath: relativeModelPath, sha256: sha256Schema,
  byteCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  upstreamRevision: z.string().min(1), sourceUrl: httpsUrl,
  license: z.object({ spdx: z.string().min(1), codeEvidenceUrl: httpsUrl, weightsEvidenceUrl: httpsUrl,
    reviewStatus: z.enum(["REVIEWED_FOR_EVALUATION", "UNREVIEWED", "REJECTED"]), reviewReference: z.string().min(1) }).strict(),
  productionApproval: z.object({ approved: z.boolean(), evaluationEvidenceSha256: sha256Schema.nullable(),
    decisionReference: z.string().min(1).nullable() }).strict(),
}).strict();
export type LocalModelDescriptor = z.infer<typeof localModelDescriptorSchema>;

/** Verifies a mounted model. This function never downloads, executes, promotes, or silently substitutes weights.
 * Production must use /models. An isolated evaluation can supply its own temporary mount directory.
 * The caller must keep the model volume read-only during inference; verification is not a filesystem lock.
 */
export async function verifyLocalModel(input: LocalModelDescriptor,
  options: { modelRoot: string; usage: "evaluation" | "production" }) {
  const descriptor = localModelDescriptorSchema.parse(input);
  const usage = z.enum(["evaluation", "production"]).parse(options.usage);
  if (!path.isAbsolute(options.modelRoot)) throw new Error("LOCAL_MODEL_ROOT_MUST_BE_ABSOLUTE");
  if (usage === "production" && path.resolve(options.modelRoot) !== "/models") throw new Error("LOCAL_MODEL_PRODUCTION_VOLUME_REQUIRED");
  if (descriptor.license.reviewStatus !== "REVIEWED_FOR_EVALUATION") throw new Error("LOCAL_MODEL_LICENSE_REVIEW_REQUIRED");
  if (usage === "production" && (!descriptor.productionApproval.approved ||
      !descriptor.productionApproval.evaluationEvidenceSha256 || !descriptor.productionApproval.decisionReference)) {
    throw new Error("LOCAL_MODEL_PRODUCTION_APPROVAL_REQUIRED");
  }
  const root = await realpath(options.modelRoot);
  const requested = path.join(root, descriptor.relativePath);
  if (!(await lstat(requested)).isFile()) throw new Error("LOCAL_MODEL_REGULAR_FILE_REQUIRED");
  const actualPath = await realpath(requested);
  if (!actualPath.startsWith(root + path.sep)) throw new Error("LOCAL_MODEL_PATH_ESCAPES_VOLUME");
  const before = await lstat(actualPath);
  if (before.size !== descriptor.byteCount) throw new Error("LOCAL_MODEL_BYTE_COUNT_MISMATCH");
  const actual = await fileIdentity(actualPath);
  const after = await lstat(actualPath);
  if (actual.sha256 !== descriptor.sha256 || actual.byteCount !== descriptor.byteCount ||
      before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    throw new Error("LOCAL_MODEL_CHECKSUM_MISMATCH");
  }
  return { path: actualPath, modelId: descriptor.modelId, version: descriptor.version, roles: descriptor.roles,
    sha256: actual.sha256, byteCount: actual.byteCount, upstreamRevision: descriptor.upstreamRevision,
    licenseSpdx: descriptor.license.spdx, licenseReviewReference: descriptor.license.reviewReference, usage };
}
