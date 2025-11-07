"use client";

import React, { Suspense } from "react";
import { useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic"; // evitar prerender

type Direction = "across" | "down";
type Meta = { source?: string; reason?: string; [k: string]: unknown };

interface Entry {
  number: number;
  row: number;
  col: number;
  direction: Direction;
  answer: string;
  clue: string;
}
interface Crossword {
  theme: string;
  language: "es" | "en";
  size: number;
  grid: string[][];
  entries: Entry[];
  meta?: Meta;
}

function isGenericClue(clue: string) {
  return /\b(pista temática|cruce|conjunci[oó]n|abreviatura)\b/i.test(clue);
}

function coordsForEntry(e: Entry): Array<string> {
  const out: string[] = [];
  for (let k = 0; k < e.answer.length; k++) {
    const r = e.row + (e.direction === "down" ? k : 0);
    const c = e.col + (e.direction === "across" ? k : 0);
    out.push(`${r}:${c}`);
  }
  return out;
}

function PreviewInner() {
  const search = useSearchParams();
  const [data, setData] = React.useState<Crossword | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);

  React.useEffect(() => {
    const hydrate = async () => {
      setLoading(true);
      setError(null);

      // Plan A: sessionStorage
      try {
        const raw = sessionStorage.getItem("generatedCrossword");
        if (raw) {
          const parsed = JSON.parse(raw) as Crossword;
          if (parsed?.grid?.length) {
            setData(parsed);
            setLoading(false);
            return;
          }
        }
      } catch {}

      // Plan B: refetch con theme/lang
      const theme =
        search.get("theme") ||
        (typeof window !== "undefined" ? localStorage.getItem("ftc:lastTheme") : "") ||
        "Argentina";
      const lang =
        (search.get("lang") as "es" | "en") ||
        (typeof window !== "undefined"
          ? ((localStorage.getItem("ftc:lastLang") as "es" | "en" | null) ?? "es")
          : "es");

      try {
        const res = await fetch("/api/generate-crossword", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme, language: lang, size: 9 }),
        });
        const cw = (await res.json()) as Crossword;
        if (!res.ok || !cw?.grid?.length) {
          setError("No se pudo obtener un crucigrama para previsualizar.");
        } else {
          setData(cw);
          try {
            sessionStorage.setItem("generatedCrossword", JSON.stringify(cw));
          } catch {}
        }
      } catch {
        setError("No se pudo contactar al endpoint desde la vista previa.");
      } finally {
        setLoading(false);
      }
    };

    void hydrate();
  }, [search]);

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl p-4">
        <h1 className="text-2xl font-semibold">Vista previa del crucigrama</h1>
        <p className="text-sm text-gray-500 mt-2">Cargando…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-6xl p-4">
        <h1 className="text-2xl font-semibold mb-2">Vista previa del crucigrama</h1>
        <p className="text-red-600">{error}</p>
        <div className="mt-4">
          <a href="/generar" className="inline-block rounded-xl px-4 py-2 bg-black text-white">
            Volver a /generar
          </a>
        </div>
      </main>
    );
  }

  if (!data) return null;

  const n = data.size;
  const across = data.entries.filter((en) => en.direction === "across");
  const down = data.entries.filter((en) => en.direction === "down");

  // Detectar entradas sospechosas (len<=3 o pista genérica)
  const suspect = new Set<string>();
  const suspectIds = new Set<number>();
  for (const e of data.entries) {
    const badLen = e.answer.trim().length <= 3;
    const badClue = isGenericClue(e.clue || "");
    if (badLen || badClue) {
      suspectIds.add(e.number);
      for (const key of coordsForEntry(e)) suspect.add(key);
    }
  }

  const hasSource = typeof data.meta?.source === "string" && data.meta.source.length > 0;
  const hasReason = typeof data.meta?.reason === "string" && String(data.meta.reason).length > 0;

  return (
    <main className="mx-auto max-w-6xl p-4">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Vista previa (solo lectura)</h1>
            <p className="text-sm text-gray-600">
              Tema: <strong>{data.theme}</strong> · Idioma: <strong>{data.language}</strong> ·{" "}
              Tamaño: <strong>{n}×{n}</strong> ·{" "}
              Entradas: <strong>{across.length}H/{down.length}V</strong>
            </p>
            {hasSource && (
              <p className="text-xs text-gray-500 mt-1">
                Fuente: {data.meta!.source}
                {hasReason ? ` — ${String(data.meta!.reason)}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/generar"
              className="rounded-xl px-3 py-2 bg-white border text-black hover:bg-gray-50"
            >
              Generar otro
            </a>
            <a
              href="/jugar/pro?src=gen"
              className="rounded-xl px-3 py-2 bg-black text-white hover:opacity-90"
            >
              Jugar este
            </a>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Celdas <span className="inline-block px-1 rounded bg-red-100">rojas</span> = palabras sospechosas (≤3 letras o pista genérica).
        </p>
      </header>

      {/* Layout limpio sin “rectángulo” intermedio */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        {/* Grid */}
        <div className="justify-self-start">
          <div
            className="grid border-2 border-black"
            style={{
              gridTemplateColumns: `repeat(${n}, minmax(28px, 36px))`,
              gridTemplateRows: `repeat(${n}, minmax(28px, 36px))`,
            }}
            aria-label="Crucigrama (vista previa)"
          >
            {data.grid.flatMap((row, r) =>
              row.map((cell, c) => {
                const isBlock = cell === "#";
                const key = `${r}:${c}`;
                const flagged = suspect.has(key);
                return (
                  <div
                    key={key}
                    className={`relative flex items-center justify-center border border-gray-700 ${
                      isBlock ? "bg-black" : flagged ? "bg-red-100" : "bg-white"
                    }`}
                    title={!isBlock ? cell : "Bloque"}
                  >
                    {!isBlock && (
                      <span className="font-semibold select-none">
                        {cell.toUpperCase()}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Pistas */}
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold mb-2">Horizontales</h2>
            <ol className="list-decimal pl-5 space-y-1">
              {across.map((en) => {
                const isSus = suspectIds.has(en.number);
                return (
                  <li key={`a-${en.number}`} className={isSus ? "text-red-700" : ""}>
                    <span className="font-medium mr-2">{en.number}.</span>
                    <span>{en.clue || <em className="text-gray-500">[sin pista]</em>}</span>
                    <span className="ml-2 text-xs text-gray-500">({en.answer})</span>
                    {isSus && <span className="ml-2 text-xs bg-red-100 px-1 rounded">sospechosa</span>}
                  </li>
                );
              })}
            </ol>
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-2">Verticales</h2>
            <ol className="list-decimal pl-5 space-y-1">
              {down.map((en) => {
                const isSus = suspectIds.has(en.number);
                return (
                  <li key={`d-${en.number}`} className={isSus ? "text-red-700" : ""}>
                    <span className="font-medium mr-2">{en.number}.</span>
                    <span>{en.clue || <em className="text-gray-500">[sin pista]</em>}</span>
                    <span className="ml-2 text-xs text-gray-500">({en.answer})</span>
                    {isSus && <span className="ml-2 text-xs bg-red-100 px-1 rounded">sospechosa</span>}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-6xl p-4">
          <h1 className="text-2xl font-semibold">Vista previa del crucigrama</h1>
          <p className="text-sm text-gray-500 mt-2">Preparando…</p>
        </main>
      }
    >
      <PreviewInner />
    </Suspense>
  );
}
