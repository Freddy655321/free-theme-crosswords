import type { WordCandidate } from "@/app/lib/crosswordTypes";

export type FreeformBuilderDependencies = {
  isForbiddenPublishAnswer(answer: string): boolean;
};

export type FreeformBuilderInput = {
  size: number;
  candidates: WordCandidate[];
  seed: number;
  deadlineMs?: number;
  maxPlacedWords?: number;
  maxBuilds?: number;
  dependencies: FreeformBuilderDependencies;
};

export type FreeformBuilderResult = {
  grid: string[][];
  usedAnswers: string[];
  meta: Record<string, unknown>;
};
