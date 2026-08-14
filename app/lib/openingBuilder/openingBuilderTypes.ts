import type { DerivedEntry, WordCandidate } from "@/app/lib/crosswordTypes";

export type OpeningBuilderDependencies = {
  isForbiddenPublishAnswer(answer: string): boolean;
  isOverGenericThemeWordForTheme(theme: string, answer: string): boolean;
};

export type OpeningBuilderInput = {
  theme: string;
  candidates: WordCandidate[];
  seed: number;
  targetEntries: number;
  deadlineMs?: number;
  dependencies: OpeningBuilderDependencies;
};

export type OpeningBuilderResult = {
  grid: string[][];
  derived: DerivedEntry[];
  usedAnswers: string[];
  meta: Record<string, unknown>;
};
