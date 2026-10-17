import { readFile, writeFile } from "node:fs/promises";
import { evaluateSlides } from "../src/lib/media-regions/slide-evaluation";

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error("Usage: npx tsx scripts/evaluate-slides.ts INPUT.json OUTPUT.json");
  const report = evaluateSlides(JSON.parse(await readFile(input, "utf8")));
  // Reports are evidence. Never overwrite an existing report implicitly.
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote slide evaluation for ${report.sourceCount} sources and ${report.runs.length} detector runs.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Slide evaluation failed."); process.exitCode = 1; });
