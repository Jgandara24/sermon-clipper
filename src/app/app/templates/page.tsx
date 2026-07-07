import { saveBrandTemplateAction } from "@/app/actions/templates";
import { CAPTION_PRESETS } from "@/lib/editor/caption-presets";
import { formatDate } from "@/lib/format";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { parseLowerThird } from "@/lib/brand-template";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);
  const templates = await prisma.brandTemplate.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const primary = templates[0];
  const lowerThird = parseLowerThird(primary?.lowerThird);

  return (
    <div className="grid gap-6">
      <section className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Brand templates</p>
        <h1 className="mt-1 text-2xl font-semibold">Church identity and lower-thirds</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
          Create a reusable sermon clip style with church name, caption preset, colors, and a
          lower-third. Applying this in the editor stores the template id in clip state so export can
          render the lower-third.
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <form action={saveBrandTemplateAction} className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
          {primary ? <input type="hidden" name="templateId" value={primary.id} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Template name</span>
              <input
                name="name"
                defaultValue={primary?.name ?? "Sunday Sermon"}
                className="rounded-md border border-stone-300 px-3 py-2"
                required
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Church name</span>
              <input
                name="churchName"
                defaultValue={primary?.churchName ?? workspace.name}
                className="rounded-md border border-stone-300 px-3 py-2"
                required
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Speaker / pastor</span>
              <input
                name="speakerName"
                defaultValue={primary?.speakerName ?? ""}
                className="rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Caption preset</span>
              <select
                name="captionPresetId"
                defaultValue={primary?.captionPresetId ?? "clean"}
                className="rounded-md border border-stone-300 px-3 py-2"
              >
                {CAPTION_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Primary color</span>
              <input
                type="color"
                name="primaryColor"
                defaultValue={primary?.primaryColor ?? "#0f766e"}
                className="h-11 rounded-md border border-stone-300 px-2 py-1"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Accent color</span>
              <input
                type="color"
                name="accentColor"
                defaultValue={primary?.accentColor ?? "#facc15"}
                className="h-11 rounded-md border border-stone-300 px-2 py-1"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Lower-third headline</span>
              <input
                name="lowerThirdHeadline"
                defaultValue={lowerThird.headline}
                className="rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium text-stone-700">Lower-third subhead</span>
              <input
                name="lowerThirdSubhead"
                defaultValue={lowerThird.subhead}
                className="rounded-md border border-stone-300 px-3 py-2"
              />
            </label>
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" name="isDefault" defaultChecked={primary?.isDefault ?? true} />
            Use as default template
          </label>

          <button
            type="submit"
            className="mt-5 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
          >
            Save template
          </button>
        </form>

        <aside className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Saved templates</p>
          <div className="mt-4 grid gap-3">
            {templates.length === 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                No template yet. Save one to make it available in the editor.
              </p>
            ) : (
              templates.map((template) => (
                <article key={template.id} className="rounded-md border border-stone-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{template.name}</p>
                    {template.isDefault ? (
                      <span className="rounded-full bg-teal-50 px-2 py-1 text-xs font-medium text-teal-800">
                        Default
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-stone-500">{template.churchName}</p>
                  <p className="mt-2 text-xs text-stone-400">Updated {formatDate(template.updatedAt)}</p>
                </article>
              ))
            )}
          </div>
        </aside>
      </section>
    </div>
  );
}
