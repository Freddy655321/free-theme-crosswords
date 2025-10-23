// app/lib/normalizePuzzle.ts
export type PuzzleJSON = {
  version?: number;
  puzzleId?: string;
  values: string[][] | string[];
};

// Acepta values como matriz (string[][]) o como array de filas string separadas por espacios
export function normalizePuzzle(json: PuzzleJSON) {
  if (!json || !json.values) {
    throw new Error("JSON sin 'values'.");
  }

  let grid: string[][];

  if (Array.isArray(json.values) && Array.isArray(json.values[0])) {
    // Caso típico: matriz de celdas
    grid = (json.values as string[][]).map(row =>
      row.map(cell => (cell ?? "").toString())
    );
  } else if (Array.isArray(json.values)) {
    // Caso alternativo: array de filas string -> las separamos por espacios
    grid = (json.values as string[]).map(line =>
      String(line ?? "")
        .trim()
        .split(/\s+/)
    );
  } else {
    throw new Error("Formato de 'values' no reconocido.");
  }

  const rows = grid.length;
  const cols = Math.max(0, ...grid.map(r => r.length));
  // Normalizamos filas cortas
  grid = grid.map(r => (r.length === cols ? r : [...r, ...Array(cols - r.length).fill("")]));

  return { rows, cols, grid };
}
