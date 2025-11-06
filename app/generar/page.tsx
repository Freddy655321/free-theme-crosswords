// app/generar/page.tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";

type Lang = "es" | "en";

interface Entry {
  number: number;
  row: number;
  col: number;
  direction: "across" | "down";
  answer: string;
  clue: string;
}
interface Crossword {
  theme: string;
  language: Lang;
  size: number;
  grid: string[][];
  entries: Entry[];
  meta?: { source?: string; reason?: string; [k: string]: unknown };
}
interface ApiErr { error: string; }
function isApiErr(x: unknown): x is ApiErr {
  return typeof x === "object" && x !== null && typeof (x as ApiErr).error === "string";
}

export default function GeneratePage() {
  const router = useRouter();

  const [theme, setTheme] = React.useState("Argentina");
  const [language, setLanguage] = React.useState<Lang>("es");
  const [loading, setLoading] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setMsg(null);
    setError(null);
  }, [theme, language]);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/generate-crossword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme, language, size: 9 }),
      });

      const data: unknown = await res.json();

      if (!res.ok || isApiErr(data)) {
        setError(isApiErr(data) ? data.error : `Error ${res.status}: no se pudo generar el crucigrama`);
        return;
      }

      const cw = data as Crossword;

      // Plan A: sessionStorage
      try {
        sessionStorage.setItem("generatedCrossword", JSON.stringify(cw));
      } catch {
        // ignoramos; la preview tiene fallback
      }

      // Extra: guardamos últimos parámetros por si la preview necesita refetch
      try {
        localStorage.setItem("ftc:lastTheme", theme);
        localStorage.setItem("ftc:lastLang", language);
      } catch {}

      setMsg(cw.meta?.source ? `Generado (${String(cw.meta.source)})` : "Generado");

      // Navegamos pasando theme/lang para permitir fallback en la preview
      router.push(`/jugar/preview?theme=${encodeURIComponent(theme)}&lang=${language}`);
    } catch {
      setError("No se pudo contactar al endpoint.");
    } finally {
      setLoading(false);
    }
  };

  const handlePlay = () => {
    const exists = typeof window !== "undefined" && sessionStorage.getItem("generatedCrossword");
    if (exists) router.push("/jugar/pro?src=gen");
    else void handleGenerate();
  };

  return (
    <main className="mx-auto max-w-4xl p-4 space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Generar crucigrama</h1>
        <p className="text-sm text-gray-600">
          Elegí un tema y el idioma. La IA genera un puzzle temático listo para jugar.
        </p>
      </header>

      <section className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm">Tema</span>
            <input
              value={theme}
              onChange={(ev) => setTheme(ev.target.value)}
              className="rounded-xl border px-3 py-2"
              placeholder="Ej.: Argentina"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Idioma</span>
            <select
              value={language}
              onChange={(ev) => setLanguage(ev.target.value as Lang)}
              className="rounded-xl border px-3 py-2"
            >
              <option value="es">Español (ES)</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="rounded-xl px-4 py-2 bg-black text-white disabled:opacity-60"
          >
            {loading ? "Generando…" : "Generar"}
          </button>

        <button
            onClick={handlePlay}
            className="rounded-xl px-4 py-2 border bg-white"
          >
            Jugar ahora →
          </button>
        </div>

        {msg && <p className="text-green-700 text-sm">{msg}</p>}
        {error && <p className="text-red-600 text-sm">{error}</p>}
      </section>

      <div className="mt-6 h-40 w-full rounded-xl border bg-gray-50 flex items-center justify-center text-gray-400">
        Placeholder de anuncio (rect)
      </div>
    </main>
  );
}
