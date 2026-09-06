import { describe, expect, it } from "vitest";
import {
  createSignedMediaUrl,
  mediaKeyBelongsToWorkspace,
  SignedMediaScopeError,
  verifySignedMediaUrl,
} from "@/lib/media/signed-url";
import { assertNoSelectorSignal } from "@/lib/review/query";

const CHURCH = "11111111-1111-1111-1111-111111111111";
const OPERATOR = "22222222-2222-2222-2222-222222222222";

describe("keeping the selector out of the reviewer's head", () => {
  it("refuses a score, subscores, a rationale, an excerpt or a model version", () => {
    // A reviewer who has seen the machine's confidence is no longer independent of it, and an
    // independent judgement is the entire product of the human-reference phase (S14).
    for (const key of ["score", "subscores", "rationale", "excerpt", "modelVersion"]) {
      expect(() => assertNoSelectorSignal({ [key]: 1 })).toThrow(/Selector signal/);
    }
  });

  it("finds one buried several levels down, including inside an array", () => {
    expect(() =>
      assertNoSelectorSignal({ history: [{ feedback: [{ subscores: { hook: 4 } }] }] }),
    ).toThrow(/Selector signal "subscores"/);
    // And says where, so the fix is obvious.
    expect(() => assertNoSelectorSignal({ a: { b: { rationale: "x" } } })).toThrow(
      /detail\.a\.b/,
    );
  });

  it("catches a spread ClipScore row, whatever else that row gains later", () => {
    const clipScore = {
      id: "s",
      workspaceId: "w",
      clipId: "c",
      total: 82,
      subscores: { hook: 4 },
      modelVersion: "v1",
      excerpt: "…",
    };
    expect(() => assertNoSelectorSignal({ clip: { ...clipScore } })).toThrow(/Selector signal/);
  });

  it("lets an innocent count through", () => {
    // `total` is deliberately not forbidden: QC writes a free-form details document that could
    // reasonably count things, and a false positive would break the operator's page over nothing.
    expect(() =>
      assertNoSelectorSignal({ qcDetails: { version: 1, checks: [{ name: "bytes", passed: true }], total: 7 } }),
    ).not.toThrow();
    expect(() => assertNoSelectorSignal(null)).not.toThrow();
    expect(() => assertNoSelectorSignal("a string")).not.toThrow();
  });
});

describe("signing a church's file for an operator to watch", () => {
  const key = `${CHURCH}/exports/final.mp4`;

  it("signs with the workspace that owns the file", () => {
    const url = createSignedMediaUrl({ key, workspaceId: CHURCH, contentType: "video/mp4" });
    const verified = verifySignedMediaUrl(new URL(url, "http://x").searchParams);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.workspaceId).toBe(CHURCH);
    expect(mediaKeyBelongsToWorkspace(verified.key, verified.workspaceId)).toBe(true);
  });

  it("refuses to sign a church's file for the operator's own workspace", () => {
    // The trap this closes: the media route checks the key against the id inside the signature,
    // so an operator-scoped link is signed perfectly and then 403s at playback with nothing to
    // explain it. It now fails at the line that got it wrong.
    expect(() => createSignedMediaUrl({ key, workspaceId: OPERATOR })).toThrow(
      SignedMediaScopeError,
    );
    expect(() => createSignedMediaUrl({ key, workspaceId: OPERATOR })).toThrow(
      /does not belong to it/,
    );
  });

  it("agrees with the media route about what belongs where", () => {
    expect(mediaKeyBelongsToWorkspace(`${CHURCH}/a.mp4`, CHURCH)).toBe(true);
    expect(mediaKeyBelongsToWorkspace(`exports/${CHURCH}/a.mp4`, CHURCH)).toBe(true);
    expect(mediaKeyBelongsToWorkspace("fixtures/sample.mp4", CHURCH)).toBe(true);
    expect(mediaKeyBelongsToWorkspace(`${CHURCH}/a.mp4`, OPERATOR)).toBe(false);
    // A prefix that merely starts the same must not pass.
    expect(mediaKeyBelongsToWorkspace(`${CHURCH}extra/a.mp4`, CHURCH)).toBe(false);
  });
});
