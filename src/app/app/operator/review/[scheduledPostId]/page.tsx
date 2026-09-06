import { notFound } from "next/navigation";
import { RenderedClipReview } from "@/components/operator/rendered-clip-review";
import { requirePlatformOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadOperatorReviewDetail } from "@/lib/review/query";

export const dynamic = "force-dynamic";

/**
 * One slot, and the exact file it will publish.
 *
 * `params` is a promise in Next 16 and has to be awaited. The operator check runs before the
 * detail is loaded, and in this page rather than a layout — a layout does not stop a route
 * segment from rendering.
 */
export default async function OperatorReviewDetailPage({
  params,
}: {
  params: Promise<{ scheduledPostId: string }>;
}) {
  await requirePlatformOperator();

  const { scheduledPostId } = await params;
  const detail = await loadOperatorReviewDetail(prisma, scheduledPostId);
  if (!detail) notFound();

  return <RenderedClipReview detail={detail} />;
}
