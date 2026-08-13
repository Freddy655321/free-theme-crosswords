import type { DerivedEntry, WordCandidate } from "@/app/lib/crosswordTypes";

export type BestPartialBuilt = {
  grid: string[][];
  usedAnswers: string[];
  meta: Record<string, unknown>;
};

export type BestPartial = {
  built: BestPartialBuilt;
  derived: DerivedEntry[];
  pool: WordCandidate[];
  notesByAnswer: Map<string, string>;
  trustedThematicSet: Set<string>;
  attempt: number;
  fallbackScore: number;
};

export type BestPartialCandidateInput = {
  built: BestPartialBuilt;
  derived: DerivedEntry[];
  pool: WordCandidate[];
  notesByAnswer: Map<string, string>;
  thematicKeepSet: Set<string>;
  attempt: number;
  fallbackScore: number;
};
