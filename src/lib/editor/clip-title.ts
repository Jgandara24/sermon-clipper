// What a clip's own title should look like.
//
// The plan asks for a generated title of at most five words. Five is a target rather than a limit:
// every clip made before this rule has a longer one, and refusing to save what a church already
// approved would be a worse fault than a long title. So the editor counts the words, says when a
// title has run past the target, and saves it either way.

export const CLIP_TITLE_WORD_TARGET = 5;
/** The column the title is stored in accepts this much, and the field must not offer more. */
export const CLIP_TITLE_MAX_CHARS = 200;

export function countTitleWords(title: string): number {
  const trimmed = title.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export function isTitleOverTarget(title: string): boolean {
  return countTitleWords(title) > CLIP_TITLE_WORD_TARGET;
}
