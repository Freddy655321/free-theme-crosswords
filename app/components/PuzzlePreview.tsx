"use client";

type Props = {
  rows: number;
  cols: number;
  grid: string[][];
};

export default function PuzzlePreview({ rows, cols, grid }: Props) {
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ marginBottom: ".5rem" }}>Vista previa del grid</h2>
      <div
        role="grid"
        aria-rowcount={rows}
        aria-colcount={cols}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 28px)`,
          gridTemplateRows: `repeat(${rows}, 28px)`, // ← usamos `rows` y se va el warning
          gap: "2px",
          userSelect: "none",
        }}
      >
        {grid.flatMap((row, r) =>
          row.map((cell, c) => {
            const empty = !cell || cell.trim() === "" || cell === "#";
            return (
              <div
                key={`${r}-${c}`}
                role="gridcell"
                aria-colindex={c + 1}
                aria-rowindex={r + 1}
                style={{
                  width: 28,
                  height: 28,
                  lineHeight: "28px",
                  textAlign: "center",
                  fontFamily: "monospace",
                  fontWeight: 700,
                  border: "1px solid #ddd",
                  background: empty ? "#f5f5f5" : "white",
                }}
                title={`(${r + 1},${c + 1}) ${cell || ""}`}
              >
                {empty ? "" : cell.toUpperCase()}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
