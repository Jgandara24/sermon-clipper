import Link from "next/link";
import { formatDate } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

type ProjectCardProps = {
  project: {
    id: string;
    name: string;
    status: string;
    series: string | null;
    speaker: string | null;
    createdAt: Date;
    sourceVideo: {
      durationS: { toNumber(): number } | null;
      originUrl: string | null;
      filename: string | null;
    } | null;
    _count: {
      generatedClips: number;
    };
  };
};

export function ProjectCard({ project }: ProjectCardProps) {
  const duration = project.sourceVideo?.durationS?.toNumber();

  return (
    <Link
      href={`/app/projects/${project.id}`}
      className="block rounded-lg border border-stone-200 bg-white p-5 shadow-sm transition hover:border-teal-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-stone-950">{project.name}</h3>
          <p className="mt-1 text-sm text-stone-500">
            {project.series ?? "No series"} {project.speaker ? `- ${project.speaker}` : ""}
          </p>
        </div>
        <StatusBadge status={project.status} />
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-stone-500">Created</p>
          <p className="mt-1 font-medium">{formatDate(project.createdAt)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-stone-500">Length</p>
          <p className="mt-1 font-medium">{duration ? `${Math.round(duration)}s` : "Draft"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-stone-500">Clips</p>
          <p className="mt-1 font-medium">{project._count.generatedClips}</p>
        </div>
      </div>
      <p className="mt-4 truncate text-xs text-stone-500">
        {project.sourceVideo?.originUrl ?? project.sourceVideo?.filename ?? "Source not attached yet"}
      </p>
    </Link>
  );
}
