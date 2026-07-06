import { ExportTable } from "@/components/export-table";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function ExportsPage() {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);

  const jobs = await prisma.exportJob.findMany({
    where: { workspaceId: workspace.id },
    include: { clip: true, outputFile: true },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();

  return (
    <div className="grid gap-6">
      <div>
        <p className="text-sm font-medium text-teal-800">Exports</p>
        <h1 className="mt-1 text-2xl font-semibold">Download history</h1>
        <p className="mt-1 text-sm text-stone-500">Every export you&apos;ve rendered, newest first.</p>
      </div>

      <ExportTable
        initialExports={jobs.map((job) => ({
          id: job.id,
          clipTitle: job.clip.title,
          filename: job.filename,
          state: job.state,
          progress: job.progress,
          errorMessageUser: job.errorMessageUser,
          createdAt: job.createdAt.toISOString(),
          downloadUrl:
            job.outputFile && job.outputFile.downloadExpiresAt > now
              ? `/api/exports/${job.id}/download`
              : null,
          linkExpired: Boolean(job.outputFile) && job.outputFile!.downloadExpiresAt <= now,
        }))}
      />
    </div>
  );
}
