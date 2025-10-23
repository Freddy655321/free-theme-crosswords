// app/components/GridNumbered.tsx
"use client";

import { useMemo } from "react";
import type { Puzzle } from "../../types/puzzle";

export default function GridNumbered({ puzzle }: { puzzle: Puzzle }) {
  const cells = useMemo(() => puzzle.grid, [puzzle.grid]);

  return (
    <div className="inline-grid" style={{ gridTemplateColumns: `repeat(${puzzle.width}, 2rem)` }}>
      {cells.map((cell) => (
        <div
          key={`${cell.row}-${cell.col}`}
          className={`relative h-8 w-8 border border-gray-300 flex items-center justify-center text-sm font-medium ${
            cell.isBlock ? "bg-gray-800" : "bg-white"
          }`}
        >
          {!cell.isBlock && cell.number ? (
            <span className="absolute left-0.5 top-0.5 text-[10px] text-gray-500">{cell.number}</span>
          ) : null}
          {!cell.isBlock ? (cell.char || "") : null}
        </div>
      ))}
    </div>
  );
}
