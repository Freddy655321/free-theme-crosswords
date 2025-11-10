// app/generar/page.tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";

type Lang = "es" | "en";
type Difficulty = "easy" | "medium" | "hard";

type Direction = "across" | "down";
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
  language: Lang;
  size: number;
  grid: string[][];
  entries: Entry[];
  meta?: Record<string, unknown>;
}

const DIFF_TO_SIZE: Record<Difficulty, number> = {
  easy: 9,
  medium: 11,
  hard: 13,
};

// Type guard para detectar { error: string } sin usar `any`
function isErrorShape(x: unknown): x is { error: string } {
  if (!x || typeof x !== "object") return false;
  const rec = x as Record<string, unknown>;
  return typeof rec.error === "string";
}

export default function GeneratePage() {
  const router = useRouter();

  const [theme, setTheme] = React.useState<string>("Argentina");
  const [lang, setLang] = React.useState<Lang>("es");
  const [diff, setDiff] = React.useState<Difficulty>("easy");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string>("");

  const size = DIFF_TO_SIZE[diff];

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setMsg("");

    try {
      const res = await fetch("/api/generate-crossword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme, language: lang, size }),
      });

      const data: unknown = await res.json();

      if (!res.ok || isErrorShape(data)) {
        setError(`Error ${res.status}: no se pudo generar el crucigrama`);
        setLoading(false);
        return;
      }

      const cw = data as Crossword;

      // Guardar para preview y juego
      try {
        sessionStorage.setItem("generatedCrossword", JSON.stringify(cw));
        localStorage.setItem("ftc:lastTheme", theme);
        localStorage.setItem("ftc:lastLang", lang);
      } catch {
        // storage opcional
      }

      setMsg(`Generado (${cw.size}×${cw.size})`);
      setLoading(false);

      // Ir a vista previa (QA)
      router.push(`/jugar/preview?theme=${encodeURIComponent(theme)}&lang=${lang}`);
    } catch {
      setError("Fallo de red al llamar al endpoint.");
      setLoading(false);
    }
  };

  const playNow = () => {
    router.push("/jugar/pro?src=gen&lang=" + lang);
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-3xl font-semibold">Generar crucigrama</h1>
      <p className="text-sm text-gray-600 mt-2">
        Elegí un tema, idioma y dificultad. La IA genera un puzzle temático listo para jugar.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {/* Tema */}
        <label className="block">
          <span className="text-sm font-medium">Tema</span>
          <input
            className="mt-1 w-full rounded-xl border px-3 py-2"
            placeholder="Tema (ej: Argentina)"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          />
        </label>

        {/* Idioma */}
        <label className="block">
          <span className="text-sm font-medium">Idioma</span>
          <select
            className="mt-1 w-full rounded-xl border px-3 py-2"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
          >
            <option value="es">Español (ES)</option>
            <option value="en">English (EN)</option>
          </select>
        </label>

        {/* Dificultad */}
        <label className="block">
          <span className="text-sm font-medium">Dificultad</span>
          <div className="mt-1 flex gap-2">
            <button
              className={`rounded-xl px-3 py-2 border ${
                diff === "easy" ? "bg-black text-white" : "bg-white"
              }`}
              onClick={() => setDiff("easy")}
              type="button"
            >
              Fácil (9×9)
            </button>
            <button
              className={`rounded-xl px-3 py-2 border ${
                diff === "medium" ? "bg-black text-white" : "bg-white"
              }`}
              onClick={() => setDiff("medium")}
              type="button"
            >
              Medio (11×11)
            </button>
            <button
              className={`rounded-xl px-3 py-2 border ${
                diff === "hard" ? "bg-black text-white" : "bg-white"
              }`}
              onClick={() => setDiff("hard")}
              type="button"
            >
              Difícil (13×13)
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-500">Tamaño actual: {size}×{size}</p>
        </label>
      </div>

      <div className="mt-6 flex gap-3">
        <button
          className="rounded-xl px-4 py-2 bg-black text-white disabled:opacity-50"
          onClick={handleGenerate}
          disabled={loading}
          type="button"
        >
          {loading ? "Generando..." : "Generar"}
        </button>
        <button
          className="rounded-xl px-4 py-2 border bg-white"
          onClick={playNow}
          type="button"
        >
          Jugar ahora →
        </button>
      </div>

      <div className="mt-3 text-sm">
        {error && <p className="text-red-600">{error}</p>}
        {!error && msg && <p className="text-gray-700">{msg}</p>}
      </div>

      {/* Placeholder de anuncio (no bloquea) */}
      <div className="mt-8 rounded-2xl border border-dashed p-8 text-center text-gray-400">
        Placeholder de anuncio (rect)
      </div>

      <div className="mt-8">
        <p className="text-sm text-gray-600">Sugerencias de prueba</p>
        <ul className="list-disc pl-5 text-sm text-gray-700">
          <li>Tema: <strong>Argentina</strong>, Idioma: <strong>es</strong></li>
          <li>Tema: <strong>Metallica</strong>, Idioma: <strong>en</strong></li>
          <li>Tema: <strong>Energías renovables</strong>, Idioma: <strong>es</strong></li>
        </ul>
      </div>
    </main>
  );
}
