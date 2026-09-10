import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./release-rehearsal";

export function removeFixtureObject(root: string, file: string, expectedHash: string, references: number) {
  if (!Number.isSafeInteger(references) || references !== 0) throw new Error("Fixture object still has references.");
  if (path.dirname(file) !== path.join(root, "storage") || lstatSync(file).isSymbolicLink() || sha256(readFileSync(file)) !== expectedHash) throw new Error("Owned object cleanup identity differs.");
  unlinkSync(file);
}
