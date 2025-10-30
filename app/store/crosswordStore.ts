// app/store/crosswordStore.ts
"use client";

import { create, StateCreator } from "zustand";
import type {
  Puzzle,
  Cell as cellT,
  Clue as clueT,
  Direction,
} from "../../types/puzzle";
export type { Direction } from "../../types/puzzle"; // ← re-export para ClueList
import { loadQuickplay } from "../lib/quickplay";

// ===== Tipos del payload generado por la IA (validados por nuestro endpoint) =====
type GenLanguage = "es" | "en";
type GenDirection = "across" | "down";

interface GenClue {
  number: number;
  answer: string; // puede venir con acentos fuera del grid
  row: number; // 0-based
  col: number; // 0-based
  direction: GenDirection;
  clue: string; // texto de la pista
}

interface GeneratedPayload {
  theme: string;
  language: GenLanguage;
  size: number; // cuadrado
  grid: string[][]; // letras A-Z o "#"
  clues: GenClue[]; // across + down
  title: string;
  notes?: string;
}

// ===== Utilidades =====
function idx(width: number, row: number, col: number) {
  return row * width + col;
}

function normalizeAnswer(s: string) {
  const map: Record<string, string> = {
    á: "A",
    é: "E",
    í: "I",
    ó: "O",
    ú: "U",
    ü: "U",
    ñ: "N",
  };
  return s
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (ch) => map[ch] || ch)
    .replace(/[^a-z0-9]/g, "")
    .toUpperCase();
}

function fromGeneratedToPuzzle(p: GeneratedPayload): Puzzle {
  const n = p.size;
  const width = n;
  const height = n;

  // Inicializamos grid flatten
  const grid: cellT[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const ch = p.grid[r]?.[c] ?? "#";
      const isBlock = ch === "#";
      const cell: cellT = {
        row: r,
        col: c,
        char: isBlock ? "" : (ch || "").toUpperCase(),
        isBlock,
      };
      grid.push(cell);
    }
  }

  // Numeración: colocamos el número en la celda de inicio de cada pista
  for (const cl of p.clues) {
    const i = idx(width, cl.row, cl.col);
    const current = grid[i];
    if (!current || current.isBlock) continue;
    if (typeof current.number === "number") {
      current.number = Math.min(current.number, cl.number);
    } else {
      current.number = cl.number;
    }
  }

  // Clues
  const clues: clueT[] = p.clues.map((cl) => ({
    number: cl.number,
    direction: cl.direction as Direction,
    answer: normalizeAnswer(cl.answer),
    text: cl.clue,
  }));

  const puzzle: Puzzle = {
    id: `gen-${Date.now()}`,
    title: p.title || `Crucigrama: ${p.theme}`,
    width,
    height,
    grid,
    clues,
  };

  return puzzle;
}

// ===== Estado =====
export interface Selection {
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

  // 🔄 utilidades
  setCharAt: (row: number, col: number, ch: string) => void;
  hydrateFromChars: (chars: string[]) => void;
  getChars: () => string[];

  // 🧠 NUEVO: cargar desde payload generado por IA
  loadFromGenerated: (payload: GeneratedPayload) => void;
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

    const start = p.grid.find((c) => !c.isBlock && c.number === num);
    if (!start) return;
    set({ selection: { row: start.row, col: start.col }, direction: dir });
  },

  // ======= utilidades para persistencia =======
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
    return p.grid.map((cell) => (cell.isBlock ? "" : cell.char ?? ""));
  },

  // ======= NUEVO: cargar desde IA =======
  loadFromGenerated: (payload: GeneratedPayload) => {
    const puzzle = fromGeneratedToPuzzle(payload);
    set({
      puzzle,
      selection: { row: 0, col: 0 },
      direction: "across",
    });
  },
});

export const useCrosswordStore = create<CrosswordState>(creator);
