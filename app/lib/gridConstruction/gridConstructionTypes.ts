import type { Cell, Direction } from "@/app/lib/crosswordTypes";

export type GridPlacementFailureReason =
  | "out_of_bounds"
  | "blocked_cell"
  | "letter_conflict"
  | "side_touch_up"
  | "side_touch_down"
  | "side_touch_left"
  | "side_touch_right"
  | "before_cell_occupied"
  | "after_cell_occupied";

export type GridPlacementCheck = {
  ok: boolean;
  crossings: number;
  reason?: GridPlacementFailureReason;
};

export type GridPlacementChange = {
  r: number;
  c: number;
  prev: Cell;
};

export type PatternSlot = {
  row: number;
  col: number;
  direction: Direction;
  len: number;
  cells: Array<{ r: number; c: number }>;
};

export type PlaceWordPolicies = {
  isForbiddenPublishAnswer(answer: string): boolean;
};
