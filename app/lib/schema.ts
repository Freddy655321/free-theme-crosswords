// app/lib/schema.ts
import { z } from "zod";

/** Celda de la rejilla: "" (vacía), "#" (bloque) o letra A-Z */
export const Cell = z.string();

/** Matriz NxN de celdas */
export const GridSchema = z
  .array(z.array(Cell))
  .min(5, "Grid demasiado chico")
  .max(35, "Grid demasiado grande");

/** Clue simple { num, clue, answer } */
export const ClueItem = z.object({
  num: z.number().int().positive(),
  clue: z.string().min(1),
  answer: z.string().min(1),
});

export const CluesSchema = z.object({
  across: z.array(ClueItem),
  down: z.array(ClueItem),
});

/** Dirección de una entrada */
export const DirSchema = z.enum(["A", "D"]);

/** Entrada con coordenadas y pista */
export const EntrySchema = z.object({
  dir: DirSchema,              // "A" (Across) o "D" (Down)
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  answer: z.string().min(1),   // solo letras
  clue: z.string().min(1),
});

/** Conjunto de entradas */
export const EntriesSchema = z.object({
  size: z.number().int().min(5).max(25),
  entries: z.array(EntrySchema).min(3),
});

/** Puzzle construido (grid + pistas) */
export const PuzzleSchema = z.object({
  version: z.number().default(1),
  puzzleId: z.string().default("generated"),
  values: GridSchema,
  clues: CluesSchema.optional(),
  meta: z
    .object({
      theme: z.string().optional(),
      size: z.number().optional(),
      difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    })
    .optional(),
});

export type Dir = z.infer<typeof DirSchema>;
export type Entry = z.infer<typeof EntrySchema>;
export type Entries = z.infer<typeof EntriesSchema>;
export type Puzzle = z.infer<typeof PuzzleSchema>;
