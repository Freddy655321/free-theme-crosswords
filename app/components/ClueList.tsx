// app/components/ClueList.tsx
"use client";

import type { Puzzle, Direction } from "../../types/puzzle";
import { useMemo } from "react";
import { useCrosswordStore } from "../store/crosswordStore";

export default function ClueList({ puzzle }: { puzzle: Puzzle }) {
  const { selection, direction, selectClue, setDirection } = useCrosswordStore();

  const across = useMemo(
    () => puzzle.clues.filter((c) => c.direction === "across").sort((a, b) => a.number - b.number),
    [puzzle]
  );
  const down = useMemo(
    () => puzzle.clues.filter((c) => c.direction === "down").sort((a, b) => a.number - b.number),
    [puzzle]
  );

  const activeNumbers = useMemo(() => {
    if (!selection) return { across: null as number | null, down: null as number | null };

    const { row, col } = selection;

    // Across: retroceder hasta el inicio de palabra
    let c = col;
    while (c - 1 >= 0 && !puzzle.grid[row * puzzle.width + (c - 1)].isBlock) c--;
    const numAcross = (puzzle.grid[row * puzzle.width + c].number ?? null) as number | null;

    // Down: retroceder hasta el inicio de palabra
    let r = row;
    while (r - 1 >= 0 && !puzzle.grid[(r - 1) * puzzle.width + col].isBlock) r--;
    const numDown = (puzzle.grid[r * puzzle.width + col].number ?? null) as number | null;

    return { across: numAcross, down: numDown };
  }, [selection, puzzle]);

  function handleClick(num: number, dir: Direction) {
    setDirection(dir);
    selectClue(num, dir);
  }

  const activeDir = direction;
  const oppositeDir: Direction = activeDir === "across" ? "down" : "across";

  const activeNum = activeDir === "across" ? activeNumbers.across : activeNumbers.down;
  const oppositeNum = oppositeDir === "across" ? activeNumbers.across : activeNumbers.down;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Across */}
      <div>
        <h3 className="font-semibold mb-2">Across</h3>
        <ul className="space-y-1">
          {across.map((c) => {
            const isActive = activeDir === "across" && activeNum === c.number;
            const isOpposite = oppositeDir === "across" && oppositeNum === c.number;
            const bg =
              isActive
                ? "bg-blue-50 ring-1 ring-blue-400"
                : isOpposite
                ? "bg-yellow-50 ring-1 ring-yellow-300"
                : "";
            return (
              <li
                key={`A${c.number}`}
                className={`cursor-pointer px-1 rounded transition ${bg}`}
                onClick={() => handleClick(c.number, "across")}
              >
                <span className="font-semibold mr-1">{c.number}.</span>
                {c.text}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Down */}
      <div>
        <h3 className="font-semibold mb-2">Down</h3>
        <ul className="space-y-1">
          {down.map((c) => {
            const isActive = activeDir === "down" && activeNum === c.number;
            const isOpposite = oppositeDir === "down" && oppositeNum === c.number;
            const bg =
              isActive
                ? "bg-blue-50 ring-1 ring-blue-400"
                : isOpposite
                ? "bg-yellow-50 ring-1 ring-yellow-300"
                : "";
            return (
              <li
                key={`D${c.number}`}
                className={`cursor-pointer px-1 rounded transition ${bg}`}
                onClick={() => handleClick(c.number, "down")}
              >
                <span className="font-semibold mr-1">{c.number}.</span>
                {c.text}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
