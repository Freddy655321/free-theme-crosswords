// app/jugar/ahora/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

type Clue = { num: number; clue: string; answer: string };
type Puzzle = {
  version: number;
  puzzleId: string;
  values: string[][];
  clues?: { across: Clue[]; down: Clue[] };
  meta?: { theme?: string; size?: number; difficulty?: "easy" | "medium" | "hard" };
};

const LS_KEY = "xw:quickplay";

export default function QuickPlayPage() {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setPuzzle(JSON.parse(raw));
    } catch {
      setPuzzle(null);
    }
  }, []);

  if (!puzzle) {
    return (
      <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <h1>Jugar ahora</h1>
        <p>No encontré un puzzle generado. Volvé a <a href="/generar">/generar</a> y tocá “Jugar ahora”.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Jugar ahora</h1>
        <small style={{ color: "var(--muted, #666)" }}>
          {puzzle.meta?.theme} · {puzzle.meta?.size}x{puzzle.meta?.size} · {puzzle.meta?.difficulty ?? "easy"}
        </small>
      </header>

      <SimplePlayable grid={puzzle.values} />

      {puzzle.clues && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginTop: "1rem" }}>
          <div>
            <h3>Across</h3>
            <ol>
              {puzzle.clues.across.map(c => (
                <li key={`A-${c.num}`}><strong>{c.num}A</strong> — {c.clue}</li>
              ))}
            </ol>
          </div>
          <div>
            <h3>Down</h3>
            <ol>
              {puzzle.clues.down.map(c => (
                <li key={`D-${c.num}`}><strong>{c.num}D</strong> — {c.clue}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </main>
  );
}

/** Rejilla editable sencilla (independiente de tu engine actual) */
function SimplePlayable({ grid }: { grid: string[][] }) {
  const cols = grid[0]?.length ?? 0;

  const [state, setState] = useState<string[][]>(() =>
    grid.map(row => row.map(cell => (cell === "#" ? "#" : (cell || "").toUpperCase())))
  );

  const isBlock = (r: number, c: number) => state[r][c] === "#";

  const handleInput = (r: number, c: number, v: string) => {
    if (isBlock(r, c)) return;
    const ch = (v.slice(-1) || "").toUpperCase().replace(/[^A-Z]/g, "");
    setState(s => {
      const copy = s.map(row => row.slice());
      copy[r][c] = ch || "";
      return copy;
    });
  };

  const styleCell = useMemo(
    () => ({
      width: 36,
      height: 36,
      lineHeight: "36px",
      textAlign: "center" as const,
      border: "1px solid #bbb",
      background: "#fff",
      fontFamily: "monospace",
      fontSize: 16,
      fontWeight: 700,
    }),
    []
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 36px)`,
        gap: "2px",
        padding: "6px",
        border: "1px solid var(--border, #e5e5e5)",
        borderRadius: 8,
        width: "max-content",
        background: "var(--card, #f7f7f7)",
        marginBottom: "1rem",
      }}
    >
      {state.flatMap((row, r) =>
        row.map((cell, c) =>
          cell === "#" ? (
            <div
              key={`${r}-${c}`}
              style={{ ...styleCell, background: "#111", borderColor: "#111" }}
            />
          ) : (
            <input
              key={`${r}-${c}`}
              value={cell}
              onChange={(e) => handleInput(r, c, e.target.value)}
              maxLength={1}
              style={{ ...styleCell, outline: "none", caretColor: "transparent" }}
            />
          )
        )
      )}
    </div>
  );
}
