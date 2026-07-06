const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "clip";
}

/** Default export filename per guide §15 step 1: `{series|project}-{clipTitle-slug}-{yyyymmdd}.mp4`. */
export function buildDefaultExportFilename(params: {
  seriesOrProject: string;
  clipTitle: string;
  date: Date;
}): string {
  const yyyy = params.date.getFullYear();
  const mm = String(params.date.getMonth() + 1).padStart(2, "0");
  const dd = String(params.date.getDate()).padStart(2, "0");
  return `${slugify(params.seriesOrProject)}-${slugify(params.clipTitle)}-${yyyy}${mm}${dd}.mp4`;
}
