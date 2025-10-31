// app/generar/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Language = "es" | "en";

type ApiError = {
  error?: string;
  message?: string;
};

type CrosswordPayload = {
  title: string;
  language: Language;
  grid: unknown; // la UI de /jugar/pro conoce la forma exacta
  clues: unknown;
  // ...otros campos que vengan del API; no son necesarios acá para navegar
};

/** Type guard genérico para objetos */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Intenta parsear JSON; si falla, devuelve null */
async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Extrae un mensaje de error legible desde posibles formas de error */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (isRecord(err)) {
    const m = err.message ?? err.error;
    if (typeof m === "string") return m;
  }
  return "Fallo de red.";
}

export default function GenerarPage() {
  const router = useRouter();
  const [theme, setTheme] = useState<string>("Argentina");
  const [language, setLanguage] = useState<Language>("es");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); // evita submit GET (origen del 405)
    setErrorMsg(null);

    const trimmed = theme.trim();
    if (!trimmed) {
      setErrorMsg("Ingresá un tema antes de generar.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/generate-crossword", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: trimmed, language }),
      });

      const data = await safeJson<CrosswordPayload & ApiError>(res);

      if (!res.ok) {
        const code = res.status;
        const detail =
          (data?.error || data?.message || "Error desconocido del servidor.");
        setErrorMsg(`HTTP ${code} — ${detail}`);
        return;
      }

      // Validación mínima para no guardar basura en sessionStorage
      const payload: unknown = data;
      if (
        !isRecord(payload) ||
        typeof payload.title !== "string" ||
        (payload.language !== "es" && payload.language !== "en")
      ) {
        setErrorMsg("La respuesta del servidor no tiene el formato esperado.");
        return;
      }

      try {
        sessionStorage.setItem(
          "generatedCrossword",
          JSON.stringify(payload),
        );
      } catch {
        // Si falla el storage, seguimos igual a /jugar/pro
      }

      router.push(`/jugar/pro?src=gen&lang=${encodeURIComponent(language)}`);
    } catch (err: unknown) {
      setErrorMsg(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Generar crucigrama</h1>
        <p className="mt-1 text-sm text-gray-500">
          Elegí un tema y el idioma. La IA genera un puzzle temático listo para jugar.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-4">
          <div className="sm:col-span-3">
            <label htmlFor="theme" className="mb-1 block text-sm font-medium">
              Tema
            </label>
            <input
              id="theme"
              ref={inputRef}
              type="text"
              placeholder="Ej.: Argentina, Metallica, Energías renovables"
              className="w-full rounded-2xl border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-black/10"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="sm:col-span-1">
            <label
              htmlFor="language"
              className="mb-1 block text-sm font-medium"
            >
              Idioma
            </label>
            <select
              id="language"
              className="w-full rounded-2xl border bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/10"
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              disabled={loading}
            >
              <option value="es">Español (ES)</option>
              <option value="en">English (EN)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-2xl bg-black px-5 py-2 text-white disabled:opacity-60"
          >
            {loading ? "Generando…" : "Generar"}
          </button>

          <button
            type="button"
            onClick={() => router.push("/jugar/pro")}
            className="rounded-2xl border px-5 py-2"
          >
            Jugar ahora →
          </button>
        </div>
      </form>

      <div className="mt-6 grid h-40 place-items-center rounded-2xl border border-dashed text-sm text-gray-400">
        Placeholder de anuncio (rect)
      </div>

      {errorMsg && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">Sugerencias de prueba</h2>
        <ul className="space-y-1 list-disc pl-5 text-sm text-gray-600">
          <li>
            Tema: <strong>Argentina</strong>, Idioma: <strong>es</strong>
          </li>
          <li>
            Tema: <strong>Metallica</strong>, Idioma: <strong>en</strong>
          </li>
          <li>
            Tema: <strong>Energías renovables</strong>, Idioma: <strong>es</strong>
          </li>
        </ul>
      </section>
    </div>
  );
}
// build trigger v3
