import { runOnePendingJob } from "@/lib/jobs/runner";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
let shuttingDown = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  while (!shuttingDown) {
    let processed = false;
    try {
      processed = await runOnePendingJob();
    } catch (error) {
      console.error("[worker] unexpected error while polling for jobs", error);
    }

    if (!processed && !shuttingDown) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

console.log(`[worker] polling for processing jobs every ${POLL_INTERVAL_MS}ms`);
loop().then(() => {
  console.log("[worker] shutting down");
  process.exit(0);
});
