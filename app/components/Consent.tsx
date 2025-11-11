"use client";

import React from "react";

const STORAGE_KEY = "ftc:consent-v1";

type Status = "unknown" | "accepted" | "rejected";

export default function Consent() {
  const [status, setStatus] = React.useState<Status>("unknown");
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Status | null;
      if (saved === "accepted" || saved === "rejected") setStatus(saved);
    } catch {
      // si localStorage no está disponible, dejamos "unknown"
    }
  }, []);

  const accept = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "accepted");
    } catch {}
    setStatus("accepted");
  };

  const reject = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "rejected");
    } catch {}
    setStatus("rejected");
  };

  // No renderizar nada hasta hidratar (evita parpadeos) o si ya decidió
  if (!mounted || status !== "unknown") return null;

  // Estilo chip: no bloquea la pantalla, sin backdrop
  return (
    <div
      className="fixed bottom-4 right-4 z-50 max-w-md rounded-2xl border shadow-lg bg-white p-3 text-sm text-gray-800"
      role="dialog"
      aria-label="Consentimiento de cookies"
    >
      <p className="mb-2">
        Usamos cookies para medir el tráfico y personalizar contenido.
      </p>
      <div className="flex gap-2">
        <button
          onClick={accept}
          className="rounded-xl px-3 py-1.5 bg-black text-white hover:opacity-90"
        >
          Aceptar
        </button>
        <button
          onClick={reject}
          className="rounded-xl px-3 py-1.5 border bg-white hover:bg-gray-50"
        >
          Rechazar
        </button>
        <a
          href="/politica-cookies"
          className="ml-auto text-xs underline text-gray-600 hover:text-gray-800"
        >
          Más info
        </a>
      </div>
    </div>
  );
}
