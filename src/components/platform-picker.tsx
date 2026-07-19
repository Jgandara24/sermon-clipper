"use client";

import type { SocialPlatform } from "@prisma/client";
import { useRef } from "react";
import { updateScheduledPostPlatformAction } from "@/app/actions/schedule";

const PLATFORM_OPTIONS: Array<{ value: SocialPlatform; label: string }> = [
  { value: "FACEBOOK", label: "Facebook" },
  { value: "INSTAGRAM", label: "Instagram (coming soon)" },
  { value: "TIKTOK", label: "TikTok (coming soon)" },
  { value: "YOUTUBE", label: "YouTube (coming soon)" },
];

export function PlatformPicker({
  scheduledPostId,
  platform,
}: {
  scheduledPostId: string;
  platform: SocialPlatform;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={updateScheduledPostPlatformAction}>
      <input type="hidden" name="scheduledPostId" value={scheduledPostId} />
      <select
        name="platform"
        defaultValue={platform}
        onChange={() => formRef.current?.requestSubmit()}
        className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-xs outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
      >
        {PLATFORM_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </form>
  );
}
