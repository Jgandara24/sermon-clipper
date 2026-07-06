import { Link2, UploadCloud } from "lucide-react";
import { createDraftProjectAction } from "@/app/actions/projects";
import { ProjectCard } from "@/components/project-card";
import { UploadDropzone } from "@/components/upload-dropzone";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);

  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: {
      sourceVideo: true,
      _count: {
        select: { generatedClips: true },
      },
    },
  });

  return (
    <div className="grid gap-6">
      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-teal-800">
              <UploadCloud size={20} aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-teal-800">Upload</p>
              <h1 className="mt-1 text-2xl font-semibold">Sermon projects</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
                Upload a video to probe it for duration, resolution, and a thumbnail. Transcription
                and AI clip scoring are still stubbed until later phases.
              </p>
            </div>
          </div>
          <div className="mt-5">
            <UploadDropzone />
          </div>
        </div>

        <form
          action={createDraftProjectAction}
          className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm"
        >
          <div className="flex items-center gap-2">
            <Link2 size={18} aria-hidden="true" className="text-teal-800" />
            <h2 className="text-lg font-semibold">Or paste a link</h2>
          </div>
          <p className="mt-2 text-sm text-stone-500">
            Fetching from a URL isn&apos;t available yet — this creates a draft record you can
            revisit once URL import ships.
          </p>
          <div className="mt-5 grid gap-4">
            <div>
              <label htmlFor="name" className="text-sm font-medium">
                Project name
              </label>
              <input
                id="name"
                name="name"
                required
                placeholder="Sunday Morning Message"
                className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
            </div>
            <div>
              <label htmlFor="sourceUrl" className="text-sm font-medium">
                Source URL
              </label>
              <input
                id="sourceUrl"
                name="sourceUrl"
                type="url"
                placeholder="https://youtube.com/watch?v=..."
                className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
              <p className="mt-1 text-xs text-stone-500">Metadata fetch is stubbed.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                name="series"
                placeholder="Series"
                className="rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
              <input
                name="speaker"
                placeholder="Speaker"
                className="rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
            </div>
            <button
              type="submit"
              className="rounded-md border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              Create draft
            </button>
          </div>
        </form>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Projects</h2>
            <p className="text-sm text-stone-500">{projects.length} project records</p>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-lg border border-stone-200 bg-white p-8 text-center shadow-sm">
            <h3 className="text-base font-semibold">No projects yet</h3>
            <p className="mt-2 text-sm text-stone-500">
              Create a draft project to start the Phase 1 flow.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
