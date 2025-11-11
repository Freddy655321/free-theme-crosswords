// app/generar/page.tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";

type Lang = "es" | "en";
type ApiBody = { theme: string; language: Lang; size: number };
type ApiOk = {
  theme: string;
  language: Lang;
  size: number;
  grid: string[][];
  entries: Array<{
    number: number;
    row: number;
    col: number;
    direction: "across" | "down";
    answer: string;
    clue: string;
  }>;
  meta?: Record<string, unknown>;
};
type ApiErr = { error: string };
function isApiOk(x: unknown): x is ApiOk {
  const y = x as Partial<ApiOk>;
  return (
    !!y &&
    typeof y === "object" &&
    typeof y.theme === "string" &&
    (y.language === "es" || y.language === "en") &&
    typeof y.size === "number" &&
    Array.isArray(y.grid) &&
    Array.isArray(y.entries)
  );
}

const DIFF = [
  { label: "Fácil — 9×9", size: 9 },
  { label: "Medio — 11×11", size: 11 },
  { label: "Difícil — 13×13", size: 13 },
];

export default function GeneratePage() {
  const router = useRouter();

  const [theme, setTheme] = React.useState("Argentina");
  const [lang, setLang] = React.useState<Lang>("es");
  const [size, setSize] = React.useState<number>(11); // DEFAULT 11×11
  const [loading, setLoading] = React.useState(false);
  const [msg, setMsg] = React.useState<string>("");

  async function handleGenerar() {
    if (loading) return;
    setLoading(true);
    setMsg("");

    const body: ApiBody = { theme, language: lang, size };

    try {
      const res = await fetch("/api/generate-crossword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // Siempre esperamos 200 (el endpoint ya “siempre 200 + fallback”)
      const data = (await res.json()) as ApiOk | ApiErr;

      if (!isApiOk(data)) {
        setMsg(`La respuesta del servidor no tiene el formato esperado.`);
        setLoading(false);
        return;
      }

      // Guardar para preview y juego
      try {
        sessionStorage.setItem("generatedCrossword", JSON.stringify(data));
        localStorage.setItem("ftc:lastTheme", theme);
        localStorage.setItem("ftc:lastLang", lang);
      } catch {
        // ignoramos errores de storage
      }

      setMsg(`Generado (${data.size}×${data.size}).`);
      setLoading(false);

      // Ir a vista previa (QA)
      router.push(
        `/jugar/preview?theme=${encodeURIComponent(theme)}&lang=${lang}`
      );
    } catch {
      setMsg("Fallo de red al llamar al endpoint.");
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-3xl font-semibold mb-3">Generar crucigrama</h1>
      <p className="text-gray-600 mb-6">
        Elegí un tema, idioma y el tamaño. La IA genera un puzzle temático listo
        para jugar.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Tema */}
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Tema</span>
          <input
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="rounded-xl border px-3 py-2"
            placeholder="Argentina"
          />
        </label>

        {/* Idioma */}
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Idioma</span>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            className="rounded-xl border px-3 py-2"
          >
            <option value="es">Español (ES)</option>
            <option value="en">English (EN)</option>
          </select>
        </label>

        {/* Dificultad / Tamaño */}
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Tamaño</span>
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="rounded-xl border px-3 py-2"
          >
            {DIFF.map((d) => (
              <option key={d.size} value={d.size}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerar}
          disabled={loading}
          className="rounded-2xl bg-black text-white px-4 py-2 disabled:opacity-50"
        >
          {loading ? "Generando…" : "Generar"}
        </button>

        <a
          href="/jugar/ahora"
          className="rounded-2xl border px-4 py-2 hover:bg-gray-50"
        >
          Jugar ahora →
        </a>
      </div>

      {msg && <p className="mt-4 text-sm text-gray-700">{msg}</p>}

      <div className="mt-8 rounded-xl border p-6 text-sm text-gray-500">
        <div className="h-24 w-full rounded-xl border border-dashed flex items-center justify-center">
          Placeholder de anuncio (rect)
        </div>
      </div>

      <section className="mt-8 text-sm">
        <p className="font-medium mb-2">Sugerencias de prueba</p>
        <ul className="list-disc pl-5">
          <li>
            Tema: <span className="font-medium">Argentina</span>, Idioma: es
          </li>
          <li>
            Tema: <span className="font-medium">Metallica</span>, Idioma: en
          </li>
          <li>
            Tema: <span className="font-medium">Energías renovables</span>,
            Idioma: es
          </li>
        </ul>
      </section>
    </main>
  );
}
