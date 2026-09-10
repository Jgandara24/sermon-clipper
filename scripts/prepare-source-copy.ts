import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { applySourceCopy, copyInputSchema, copyManifestSchema, planSourceCopy, SourceCopyRefused } from "../src/lib/operations/source-copy";
import { sourceCopyStorageFromEnv } from "../src/lib/operations/source-copy-storage";

const usage = `Read-only plan (reads the source bytes to calculate SHA-256; creates no remote rows or objects):
  npm run --silent prepare:source-copy -- --operator <uuid> --import-user <uuid> --workspace <uuid> \\
    --project <uuid> --date YYYY-MM-DD --occurrence PRIMARY|SECONDARY|UNMATCHED --max-bytes <limit>
Redirect the JSON output to a private local manifest file. Do not commit source keys.
After separate approval, within 30 minutes:
  npm run --silent prepare:source-copy -- --apply --manifest <file> --confirm <hash> --confirm-sandbox <uuid>
Apply creates an operation journal, a separate object, and one SourceVideo only.
It never creates services/jobs, changes settings/holds, renders, or publishes.
The source operator also needs source IMPORT_MEDIA membership; the named importer needs target access.
A pending copy requires manual review after 24 hours. No automatic deletion is supplied.
Required environment: DATABASE_URL and STORAGE_S3_* credentials. No .env file is loaded.`;
async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" }, apply: { type: "boolean" }, manifest: { type: "string" }, confirm: { type: "string" },
    "confirm-sandbox": { type: "string" }, operator: { type: "string" }, "import-user": { type: "string" },
    workspace: { type: "string" }, project: { type: "string" }, date: { type: "string" },
    occurrence: { type: "string" }, "max-bytes": { type: "string" },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(usage); return; }
  let manifest;
  let input;
  if (values.apply) {
    if (!values.manifest || !values.confirm || !values["confirm-sandbox"] ||
      [values.operator, values["import-user"], values.workspace, values.project, values.date, values.occurrence, values["max-bytes"]].some(Boolean)) {
      throw new SourceCopyRefused("ARGUMENTS_INVALID");
    }
    const content = await readFile(values.manifest, "utf8");
    if (content.length > 16_384) throw new SourceCopyRefused("MANIFEST_TOO_LARGE");
    manifest = copyManifestSchema.parse(JSON.parse(content).plan);
  } else {
    if (values.manifest || values.confirm || values["confirm-sandbox"]) throw new SourceCopyRefused("APPLY_REQUIRED");
    input = copyInputSchema.parse({ operatorId: values.operator, importUserId: values["import-user"],
      workspaceId: values.workspace, projectId: values.project, sermonDate: values.date,
      occurrence: values.occurrence, maxBytes: Number(values["max-bytes"]) });
  }
  if (!process.env.DATABASE_URL) throw new SourceCopyRefused("DATABASE_CONFIG_REQUIRED");
  const storage = sourceCopyStorageFromEnv(process.env);
  const client = new PrismaClient();
  try {
    const result = manifest
      ? await applySourceCopy(client, storage, manifest, values.confirm!, values["confirm-sandbox"]!)
      : await planSourceCopy(client, storage, input!);
    console.log(JSON.stringify(result, null, 2));
  } finally { await client.$disconnect(); }
}
main().catch((error: unknown) => {
  console.error(error instanceof SourceCopyRefused ? error.message : "Source copy failed. No raw database or provider error is displayed. Use --help to check inputs.");
  process.exitCode = 1;
});
