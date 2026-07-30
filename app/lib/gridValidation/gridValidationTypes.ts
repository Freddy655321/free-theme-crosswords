import type { Cell, Entry } from "@/app/lib/crosswordTypes";

export type GridValidationEntry = Omit<Entry, "clue">;

export type CheckedCellStats = {
  total: number;
  checked: number;
  ratio: number;
};

export type CrossedEntryStats = {
  total: number;
  crossed: number;
  ratio: number;
};

export type EntryCrossingStats = {
  minCheckedCells: number;
  weakEntries: Array<{ answer: string; checkedCells: number }>;
  counts: Array<{ answer: string; checkedCells: number }>;
};

export type GridValidationPolicies = {
  isOverGenericThemeWord(answer: string): boolean;
};

export type GridValidationInput = {
  grid: string[][];
  derived: GridValidationEntry[];
  themeSet?: Set<string>;
  policies: GridValidationPolicies;
};

export type GridValidationResult = {
  accepted: boolean;
  issue: string | null;
  density: number;
  checkedStats: CheckedCellStats;
  crossedStats: CrossedEntryStats;
  entryCrossings: EntryCrossingStats;
};

export type GridRepairResult = {
  grid: string[][];
  derived: GridValidationEntry[];
};

export type WorkingGrid = Cell[][];
