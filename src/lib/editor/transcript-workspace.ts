export type TranscriptWorkspaceWord = {
  id: string;
  word: string;
  startMs: number;
  endMs: number;
};

export type WordNavigationRequest = {
  wordId: string;
  ms: number;
  token: number;
};

export function selectTranscriptWord(
  words: TranscriptWorkspaceWord[],
  wordId: string,
  token: number,
): { selectedWordId: string; navigation: WordNavigationRequest } | null {
  const word = words.find((candidate) => candidate.id === wordId);
  if (!word) return null;
  return {
    selectedWordId: word.id,
    navigation: { wordId: word.id, ms: word.startMs, token },
  };
}
