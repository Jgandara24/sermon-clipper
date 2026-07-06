import type { Prisma } from "@prisma/client";

export function formatMinutes(value: number | Prisma.Decimal) {
  const numberValue = typeof value === "number" ? value : value.toNumber();
  return `${numberValue.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })} min`;
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function titleCaseStatus(status: string) {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
