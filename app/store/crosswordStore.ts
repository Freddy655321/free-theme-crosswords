// app/store/crosswordStore.ts
"use client";

import { create, StateCreator } from "zustand";
import type { Puzzle } from "../../types/puzzle";
import { loadQuickplay } from "../lib/quickplay";

export type Direction = "across" | "down";

interface Selection {
  row: number;
  col: number;
}

export interface CrosswordState {
  puzzle: Puzzle | null;
  selection: Selection | null;
  direction: Direction;

  // flujo base
  setPuzzle: (p: Puzzle) => void;
  loadFromQuickplay: () => void;
  setSelection: (sel: Selection | null) => void;
  setDirection: (dir: Direction) => void;
  toggleDirection: () => void;
  inputChar: (ch: string) => void;
  move: (dr: number, dc: number) => void;
  selectClue: (num: number, dir: Direction) => void;

  // 🔄 persistencia / utilidades nuevas
  setCharAt: (row: number, col: number, ch: string) => void; // set sin mover selección
  hydrateFromChars: (chars: string[]) => void; // aplica progreso al grid
  getChars: () => string[]; // chars lineales del grid (para guardar)
}

function idx(width: number, row: number, col: number) {
  return row * width + col;
}

const creator: StateCreator<CrosswordState> = (set, get) => ({
  puzzle: null,
  selection: null,
  direction: "across",

  setPuzzle: (p: Puzzle) =>
    set(() => ({
      puzzle: p,
      selection: { row: 0, col: 0 },
      direction: "across",
    })),

  loadFromQuickplay: () => {
    const p = loadQuickplay<Puzzle>();
    if (p) {
      set({
        puzzle: p,
        selection: { row: 0, col: 0 },
        direction: "across",
      });
    }
  },

  setSelection: (sel: Selection | null) => set({ selection: sel }),
  setDirection: (dir: Direction) => set({ direction: dir }),

  toggleDirection: () =>
    set((s) => ({ direction: s.direction === "across" ? "down" : "across" })),

  inputChar: (ch: string) => {
    const s = get();
    const p = s.puzzle;
    const sel = s.selection;
    if (!p || !sel) return;

    const { row, col } = sel;
    const i = idx(p.width, row, col);
    const cell = p.grid[i];
    if (cell.isBlock) return;

    const next: Puzzle = { ...p, grid: p.grid.slice() };
    next.grid[i] = { ...cell, char: ch.toUpperCase() };

    // Avanzar a la siguiente celda según dirección
    let nr = row;
    let nc = col;
    if (s.direction === "across") nc = Math.min(col + 1, p.width - 1);
    else nr = Math.min(row + 1, p.height - 1);

    const inBounds = (r: number, c: number) =>
      r >= 0 && c >= 0 && r < p.height && c < p.width;

    while (inBounds(nr, nc) && next.grid[idx(p.width, nr, nc)].isBlock) {
      if (s.direction === "across") {
        if (nc < p.width - 1) nc++;
        else break;
      } else {
        if (nr < p.height - 1) nr++;
        else break;
      }
    }

    set({ puzzle: next, selection: { row: nr, col: nc } });
  },

  move: (dr: number, dc: number) => {
    const s = get();
    const p = s.puzzle;
    const sel = s.selection;
    if (!p || !sel) return;

    let nr = Math.max(0, Math.min(p.height - 1, sel.row + dr));
    let nc = Math.max(0, Math.min(p.width - 1, sel.col + dc));

    // Evitar quedar en bloque
    const tries = p.width + p.height;
    let t = 0;
    while (p.grid[idx(p.width, nr, nc)].isBlock && t < tries) {
      nr = Math.max(0, Math.min(p.height - 1, nr + dr));
      nc = Math.max(0, Math.min(p.width - 1, nc + dc));
      t++;
    }
    set({ selection: { row: nr, col: nc } });
  },

  selectClue: (num: number, dir: Direction) => {
    const s = get();
    const p = s.puzzle;
    if (!p) return;

    // Buscamos la celda que tiene ese 'number'
    const start = p.grid.find((c) => !c.isBlock && c.number === num);
    if (!start) return;
    set({ selection: { row: start.row, col: start.col }, direction: dir });
  },

  // ======= NUEVO: utilidades para persistencia =======

  setCharAt: (row: number, col: number, ch: string) => {
    const s = get();
    const p = s.puzzle;
    if (!p) return;

    const i = idx(p.width, row, col);
    const cell = p.grid[i];
    if (!cell || cell.isBlock) return;

    const next: Puzzle = { ...p, grid: p.grid.slice() };
    next.grid[i] = { ...cell, char: ch.toUpperCase() };
    set({ puzzle: next });
  },

  hydrateFromChars: (chars: string[]) => {
    const s = get();
    const p = s.puzzle;
    if (!p) return;

    const next: Puzzle = { ...p, grid: p.grid.slice() };
    for (let i = 0; i < next.grid.length; i++) {
      const cell = next.grid[i];
      if (cell.isBlock) continue;
      const ch = (chars[i] ?? "").toUpperCase();
      next.grid[i] = { ...cell, char: ch };
    }
    set({ puzzle: next });
  },

  getChars: () => {
    const p = get().puzzle;
    if (!p) return [];
    return p.grid.map((cell) => (cell.isBlock ? "" : (cell.char ?? "")));
  },
});

export const useCrosswordStore = create<CrosswordState>(creator);
