// app/generar/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GenerateResponse, Puzzle } from "../../types/puzzle";
import { saveQuickplay, clearQuickplay } from "../lib/quickplay";
import GridNumbered from "../components/GridNumbered";
import ClueList from "../components/ClueList";
import AdSlot from "../components/AdSlot";

export default function Page() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Slots opcionales por página
  const slotRect =
    (process.env.NEXT_PUBLIC_ADSENSE_SLOT_RECT as string | undefined) || "";

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as GenerateResponse;
      setPuzzle(data.puzzle);
      clearQuickplay();
      saveQuickplay(data.puzzle);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Generar crucigrama</h1>

      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-3 py-2"
          placeholder="Tema (ej: Planetas, Cine clásico)"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <button
          className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
          onClick={handleGenerate}
          disabled={loading}
        >
          {loading ? "Generando…" : "Generar"}
        </button>
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          onClick={() => router.push("/jugar/pro")}
          disabled={!puzzle}
          title={puzzle ? "Ir a jugar" : "Generá primero un puzzle"}
        >
          Jugar ahora →
        </button>
      </div>

      {/* Rectángulo/auto responsive entre controles y contenido */}
      {slotRect ? (
        <AdSlot slot={slotRect} className="my-2" format="auto" responsive />
      ) : null}

      {error && <p className="text-red-600">{error}</p>}

      {puzzle && (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="font-semibold mb-2">{puzzle.title}</h2>
            <GridNumbered puzzle={puzzle} />
          </div>
          <ClueList puzzle={puzzle} />
        </div>
      )}
    </main>
  );
}
