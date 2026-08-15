import { describe, expect, it } from "vitest";
import { redactJsonProxySecrets, removeJsonKeys } from "@/lib/audits/event-redaction";

const proxyUrl = "http://churchuser:s3cretpass@gate.proxy.example:7777";

describe("redactJsonProxySecrets", () => {
  it("redacts string leaves at any depth and keeps the structure", () => {
    const metadata = {
      type: "FINALIZE",
      attempt: 2,
      retryable: true,
      nested: { detail: `yt-dlp --proxy ${proxyUrl} --dump-json`, unrelated: null },
      history: [`connect ${proxyUrl}`, "clean line"],
    };

    const result = redactJsonProxySecrets(metadata, proxyUrl);

    expect(result.changed).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("s3cretpass");
    expect(JSON.stringify(result.value)).not.toContain("gate.proxy.example");
    expect(result.value).toMatchObject({
      type: "FINALIZE",
      attempt: 2,
      retryable: true,
      nested: { unrelated: null },
    });
    expect((result.value as { history: string[] }).history[1]).toBe("clean line");
  });

  it("reports no change for metadata that holds no secret", () => {
    const metadata = { type: "ANALYZE", keptCount: 6 };

    const result = redactJsonProxySecrets(metadata, proxyUrl);

    expect(result.changed).toBe(false);
    expect(result.value).toBe(metadata);
  });

  it("is idempotent", () => {
    const once = redactJsonProxySecrets({ detail: `--proxy ${proxyUrl}` }, proxyUrl);
    const twice = redactJsonProxySecrets(once.value, proxyUrl);

    expect(twice.changed).toBe(false);
    expect(twice.value).toEqual(once.value);
  });
});

describe("removeJsonKeys", () => {
  it("removes the named keys and leaves everything else", () => {
    const result = removeJsonKeys(
      { type: "ANALYZE", candidateLimit: 12, keptCount: 6, targetClipCount: 6 },
      ["candidateLimit"],
    );

    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ type: "ANALYZE", keptCount: 6, targetClipCount: 6 });
  });

  it("removes nested occurrences", () => {
    const result = removeJsonKeys({ outer: { candidateLimit: 18, keep: "yes" } }, [
      "candidateLimit",
    ]);

    expect(result.value).toEqual({ outer: { keep: "yes" } });
  });

  it("reports no change when the key is absent", () => {
    const metadata = { type: "PROBE" };

    expect(removeJsonKeys(metadata, ["candidateLimit"])).toEqual({
      value: metadata,
      changed: false,
    });
  });
});
