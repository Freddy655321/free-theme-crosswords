// lib/validateCrossword.ts
import type { CrosswordPayload } from "./crosswordSchema";
import { normalizeAnswer } from "./crosswordSchema";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validatePayload(p: CrosswordPayload): ValidationResult {
  if (!p) return { ok: false, reason: "payload vacío" };
  if (!p.theme || !p.language) return { ok: false, reason: "theme/language faltante" };

  const n = p.size;
  if (!Number.isInteger(n) || n < 5 || n > 25) return { ok: false, reason: "size fuera de rango" };

  if (!Array.isArray(p.grid) || p.grid.length !== n) return { ok: false, reason: "grid inválido" };
  for (const row of p.grid) {
    if (!Array.isArray(row) || row.length !== n) return { ok: false, reason: "fila inválida" };
    for (const c of row) {
      if (c !== "#" && !/^[A-Z]$/.test(c)) return { ok: false, reason: "celda inválida" };
    }
  }

  if (!Array.isArray(p.clues) || p.clues.length === 0) return { ok: false, reason: "clues vacías" };
  const seen = new Set<string>();

  for (const cl of p.clues) {
    if (!Number.isInteger(cl.number) || cl.number < 1) return { ok: false, reason: "número de pista inválido" };
    if (cl.direction !== "across" && cl.direction !== "down") return { ok: false, reason: "dirección inválida" };
    if (!Number.isInteger(cl.row) || !Number.isInteger(cl.col)) return { ok: false, reason: "coords inválidas" };
    if (cl.row < 0 || cl.col < 0 || cl.row >= n || cl.col >= n) return { ok: false, reason: "coords fuera" };

    const key = `${cl.direction}-${cl.number}`;
    if (seen.has(key)) return { ok: false, reason: "número repetido" };
    seen.add(key);

    const ans = normalizeAnswer(cl.answer);
    if (!ans) return { ok: false, reason: "answer vacía" };

    for (let i = 0; i < ans.length; i++) {
      const r = cl.direction === "across" ? cl.row : cl.row + i;
      const c = cl.direction === "across" ? cl.col + i : cl.col;
      if (r >= n || c >= n) return { ok: false, reason: "answer se sale del grid" };
      const cell = p.grid[r][c];
      if (cell === "#") return { ok: false, reason: "bloque en medio de answer" };
      if (cell !== ans[i]) return { ok: false, reason: "desajuste letra-grid" };
    }

    if (cl.direction === "across" && cl.col > 0 && p.grid[cl.row][cl.col - 1] !== "#") {
      return { ok: false, reason: "across no comienza tras bloque/borde" };
    }
    if (cl.direction === "down" && cl.row > 0 && p.grid[cl.row - 1][cl.col] !== "#") {
      return { ok: false, reason: "down no comienza tras bloque/borde" };
    }
  }

  return { ok: true };
}
