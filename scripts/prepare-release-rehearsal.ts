import { prepareRehearsal } from "./lib/release-rehearsal-files";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Stage A: local committed source exports, fixture specifications and evidence files only.\nUse --prepare. No worker, database, bucket or processing action exists.");
} else if (args.length === 1 && args[0] === "--prepare") {
  try {
    console.log(JSON.stringify(prepareRehearsal(process.cwd()), null, 2));
  } catch {
    // Do not echo paths, arguments, Git errors, environment values or credentials.
    console.error("Local rehearsal preparation failed. Inspect the owned p2-release-rehearsal directory in the OS temporary folder.");
    process.exitCode = 1;
  }
} else {
  console.error("Use --help or --prepare. Stage A refuses all execution options.");
  process.exitCode = 1;
}
