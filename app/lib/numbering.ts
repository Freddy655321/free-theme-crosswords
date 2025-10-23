// lib/numbering.ts
export type Dir = "A" | "D";
export type Start = { r: number; c: number; dir: Dir; num: number };
export type StartMap = Record<string, number>;

/** Dado un grid con "#" como bloque, numera inicios de palabras estilo crucigrama. */
export function computeNumbering(values: string[][]): {
  starts: StartMap;
  across: Start[];
  down: Start[];
} {
  const R = values.length;
  const C = values[0]?.length ?? 0;

  const key = (r: number, c: number, d: Dir) => `${r},${c},${d}`;
  const starts: StartMap = {};
  const across: Start[] = [];
  const down: Start[] = [];

  let num = 1;

  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (values[r][c] === "#") continue;

      const startA = c === 0 || values[r][c - 1] === "#";
      const startD = r === 0 || values[r - 1][c] === "#";

      if (startA) {
        starts[key(r, c, "A")] = num;
        across.push({ r, c, dir: "A", num });
      }
      if (startD) {
        // si no hubo across en esa celda, no incrementes doble
        if (!startA) starts[key(r, c, "D")] = num;
        else starts[key(r, c, "D")] = num; // compartir mismo número (estilo clásico)
        down.push({ r, c, dir: "D", num });
      }
      if (startA || startD) num++;
    }
  }

  return { starts, across, down };
}
