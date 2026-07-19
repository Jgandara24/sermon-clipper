import { describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandTemplate: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  requireCurrentUser: vi.fn(async () => ({ id: "user-1" })),
  requirePrimaryWorkspacePermission: vi.fn(async () => ({
    role: "OWNER",
    workspace: { id: "ws-1" },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { prisma } from "@/lib/prisma";
import { saveBrandTemplateAction } from "@/app/actions/templates";

function validFormData(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set("name", "Sunday Brand");
  formData.set("churchName", "Grace Church");
  formData.set("speakerName", "");
  formData.set("primaryColor", "#112233");
  formData.set("accentColor", "#aabbcc");
  formData.set("captionPresetId", "clean");
  formData.set("lowerThirdHeadline", "");
  formData.set("lowerThirdSubhead", "");
  formData.set("isDefault", "on");
  for (const [key, value] of Object.entries(overrides)) {
    formData.set(key, value);
  }
  return formData;
}

describe("saveBrandTemplateAction default flip", () => {
  it("clears other defaults and saves the template inside one transaction, clear first", async () => {
    const operations: string[] = [];
    const tx = {
      brandTemplate: {
        updateMany: vi.fn(async () => {
          operations.push("clear-defaults");
          return { count: 1 };
        }),
        create: vi.fn(async () => {
          operations.push("create");
          return { id: "template-1" };
        }),
        update: vi.fn(),
      },
    };
    (prisma.$transaction as Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
    );

    // The action ends in redirect(), which throws in Next. Exact match — a validation
    // failure redirects to /app/templates?error=... and must not slip past this assertion.
    await expect(saveBrandTemplateAction(validFormData())).rejects.toThrow(
      /^REDIRECT:\/app\/templates$/,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(operations).toEqual(["clear-defaults", "create"]);
    expect(tx.brandTemplate.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", isDefault: true },
      data: { isDefault: false },
    });
  });

  it("skips the clear when the template is not being made default", async () => {
    const tx = {
      brandTemplate: {
        updateMany: vi.fn(),
        create: vi.fn(async () => ({ id: "template-1" })),
        update: vi.fn(),
      },
    };
    (prisma.$transaction as Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
    );

    const formData = validFormData();
    formData.delete("isDefault");
    await expect(saveBrandTemplateAction(formData)).rejects.toThrow(/^REDIRECT:\/app\/templates$/);

    expect(tx.brandTemplate.updateMany).not.toHaveBeenCalled();
    expect(tx.brandTemplate.create).toHaveBeenCalled();
  });
});
