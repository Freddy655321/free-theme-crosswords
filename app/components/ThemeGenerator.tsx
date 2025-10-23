// components/ThemeGenerator.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Level = "easy" | "medium" | "hard";
type Clue = { num: number; clue: string; answer: string };
type Generated = {
  version: number;
  puzzleId: string;
  values: string[][];
  clues?: { across: Clue[]; down: Clue[] };
  meta?: { theme?: string; size?: number; difficulty?: Level };
};

const LS_KEY = "xw:quickplay";

function isLevel(v: string): v is Level {
  return v === "easy" || v === "medium" || v === "hard";
}

export default function ThemeGenerator() {
  const router = useRouter();
  const [theme, setTheme] = useState("");
  const [size, setSize] = useState(7);
  const [difficulty, setDifficulty] = useState<Level>("easy");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Generated | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setData(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme, size, difficulty }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Generated;
      setData(json);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `generated_${data.meta?.theme ?? "theme"}_${data.meta?.size ?? ""}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const playNow = () => {
    if (!data) return;
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    router.push("/jugar/ahora");
  };

  const grid = data?.values;

  return (
    <section style={{ padding: "1rem", border: "1px solid var(--border, #e5e5e5)", borderRadius: 12 }}>
      <form onSubmit={submit} style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Tema (p. ej., European Union)"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          style={{ padding: ".5rem", minWidth: 280 }}
          required
        />
        <select value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ padding: ".5rem" }}>
          <option value={7}>7x7</option>
          <option value={9}>9x9</option>
          <option value={11}>11x11</option>
        </select>
        <select
          value={difficulty}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (isLevel(v)) setDifficulty(v);
          }}
          style={{ padding: ".5rem" }}
        >
          <option value="easy">Fácil</option>
          <option value="medium">Media</option>
          <option value="hard">Difícil</option>
        </select>
        <button type="submit" disabled={loading}>{loading ? "Generando..." : "Generar"}</button>
        {data && (
          <>
            <button type="button" onClick={download}>Descargar JSON</button>
            <button type="button" onClick={playNow}>Jugar ahora</button>
          </>
        )}
      </form>

      {error && <p style={{ color: "crimson", marginTop: ".5rem" }}>Error: {error}</p>}

      {grid && (
        <>
          <div style={{ marginTop: "1rem" }}>
            <strong>Resultado:</strong> {data?.meta?.theme} · {data?.meta?.size}x{data?.meta?.size} · {data?.meta?.difficulty ?? "easy"}
          </div>

          <h3 style={{ marginTop: "1rem" }}>Vista previa</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${grid[0].length}, 24px)`,
              gap: "2px",
              padding: "6px",
              border: "1px solid var(--border, #e5e5e5)",
              borderRadius: 8,
              width: "max-content",
              background: "var(--card, #f7f7f7)",
            }}
          >
            {grid.flatMap((row, r) =>
              row.map((cell, c) => {
                const block = !cell || cell === "#";
                return (
                  <div
                    key={`${r}-${c}`}
                    style={{
                      width: 24,
                      height: 24,
                      lineHeight: "24px",
                      textAlign: "center",
                      background: block ? "#111" : "#fff",
                      color: block ? "transparent" : "#111",
                      border: "1px solid #bbb",
                      fontFamily: "monospace",
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {block ? "" : (cell || "").toUpperCase()}
                  </div>
                );
              })
            )}
          </div>

          {data?.clues && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginTop: "1rem" }}>
              <div>
                <h4>Across</h4>
                <ol>
                  {data.clues.across.map(c => (
                    <li key={`A-${c.num}`}><strong>{c.num}A</strong> — {c.clue} <em>({c.answer})</em></li>
                  ))}
                </ol>
              </div>
              <div>
                <h4>Down</h4>
                <ol>
                  {data.clues.down.map(c => (
                    <li key={`D-${c.num}`}><strong>{c.num}D</strong> — {c.clue} <em>({c.answer})</em></li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
