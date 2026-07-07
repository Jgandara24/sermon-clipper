import { runProductionSmoke } from "../src/lib/deployment/production-smoke";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = argValue("--base-url") ?? process.env.SMOKE_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
const timeoutMs = Number(argValue("--timeout-ms") ?? process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const expectProduction = !process.argv.includes("--allow-dev-login");

async function main() {
  if (!baseUrl) {
    console.error("Missing base URL. Use --base-url https://clips.example.org or SMOKE_BASE_URL.");
    process.exit(2);
  }

  const result = await runProductionSmoke({
    baseUrl,
    timeoutMs,
    expectProduction,
  });

  for (const check of result.checks) {
    const label = check.status.toUpperCase().padEnd(7);
    console.log(`${label} ${check.name}: ${check.message}`);
  }

  console.log(`\nProduction smoke status: ${result.status}`);

  if (result.status === "fail") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
