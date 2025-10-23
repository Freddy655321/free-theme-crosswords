"use client";

import { useEffect, useState } from "react";

export default function BundleClient() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/crosswords.bundle", { cache: "no-store" });
        if (!res.ok) throw new Error(`Bundle HTTP ${res.status}`);

        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("text/html")) {
          throw new Error("La bundle devolvió HTML (ruta/nombre incorrecto).");
        }

        const buf = await res.arrayBuffer();
        setBytes(buf.byteLength);
      } catch (err: unknown) {
        // estrechamos el tipo sin usar `any`
        if (err instanceof Error) setError(err.message);
        else setError(String(err));
      }
    })();
  }, []);

  return (
    <section style={{ marginTop: "1rem" }}>
      <h2>Bundle</h2>
      {error ? (
        <p style={{ color: "crimson" }}>Error: {error}</p>
      ) : bytes == null ? (
        <p>Cargando bundle…</p>
      ) : (
        <>
          <p>Bundle disponible: {bytes} bytes.</p>
          <p>
            <a href="/crosswords.bundle" download>
              Descargar bundle
            </a>
          </p>
        </>
      )}
    </section>
  );
}
