import { describe, expect, it } from "vitest";
import {
  classifyProxyExposure,
  proxySecretNeedles,
  proxySecretTokens,
  redactProxySecrets,
} from "@/lib/media/proxy-secret";

const proxyUrl = "http://churchuser:s3cretpass@gate.proxy.example:7777";

describe("proxySecretTokens", () => {
  it("separates credential strings from location strings", () => {
    const tokens = proxySecretTokens(proxyUrl);

    expect(tokens.credential).toContain("churchuser:s3cretpass");
    expect(tokens.credential).toContain("s3cretpass");
    expect(tokens.location).toContain(proxyUrl);
    expect(tokens.location).toContain("gate.proxy.example:7777");
  });

  it("returns nothing for an unset proxy", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(proxySecretTokens(value)).toEqual({ credential: [], location: [] });
    }
  });

  it("still yields the whole string when the URL cannot be parsed", () => {
    expect(proxySecretTokens("not-a-url-but-secret").location).toEqual(["not-a-url-but-secret"]);
  });

  it("drops tokens too short to be a safe search needle", () => {
    // A one-character password would otherwise match almost every stored row.
    expect(proxySecretTokens("http://u:p@h.example:1").credential).toEqual([]);
  });

  it("orders needles longest first so the widest match wins", () => {
    const needles = proxySecretNeedles(proxyUrl);
    expect(needles[0]).toBe(proxyUrl);
    expect(needles).toEqual([...needles].sort((a, b) => b.length - a.length));
  });
});

describe("redactProxySecrets", () => {
  it("removes every form of the secret from a command line", () => {
    const message = `Command failed: yt-dlp --proxy ${proxyUrl} --dump-json https://youtu.be/x`;

    const redacted = redactProxySecrets(message, proxyUrl);

    expect(redacted).not.toContain("s3cretpass");
    expect(redacted).not.toContain("churchuser");
    expect(redacted).not.toContain("gate.proxy.example");
    expect(redacted).toContain("--proxy");
    expect(redacted).toContain("https://youtu.be/x");
  });

  it("leaves text unchanged when no proxy is configured", () => {
    expect(redactProxySecrets("plain message", undefined)).toBe("plain message");
  });
});

describe("classifyProxyExposure", () => {
  it("reports the worst secret the text contains", () => {
    expect(classifyProxyExposure(`prefix ${proxyUrl} suffix`, proxyUrl)).toBe("credential");
    expect(classifyProxyExposure("host gate.proxy.example:7777 only", proxyUrl)).toBe("location");
    expect(classifyProxyExposure("yt-dlp --proxy [redacted]", proxyUrl)).toBe("marker");
    expect(classifyProxyExposure("nothing to see", proxyUrl)).toBe("none");
  });

  it("still detects a bare marker with no configured proxy", () => {
    expect(classifyProxyExposure("yt-dlp --proxy something", undefined)).toBe("marker");
    expect(classifyProxyExposure("yt-dlp --dump-json", undefined)).toBe("none");
  });
});
