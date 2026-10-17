/** Unknown region kinds require an explicit policy decision before video export or publication. */
export function regionBlocksVideo(kind: string): boolean {
  return kind !== "SERMON" && kind !== "PASTOR_VISIBLE";
}
