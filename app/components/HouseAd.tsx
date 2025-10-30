// app/components/HouseAd.tsx
"use client";

import { useConsent } from "./Consent";

type Kind = "leader" | "rect" | "square";

export default function HouseAd({ kind = "rect" }: { kind?: Kind }) {
  const { isProd, status } = useConsent();

  // Si estamos en producción con consentimiento aceptado,
  // no mostramos placeholder (el AdSlot real se encargará).
  if (isProd && status === "accepted") return null;

  const size =
    kind === "leader"
      ? "h-16"
      : kind === "square"
      ? "h-40"
      : "h-32"; // rect por defecto

  return (
    <div
      className={`border border-dashed rounded ${size} w-full flex items-center justify-center text-sm text-gray-500 bg-gray-50`}
      role="img"
      aria-label="Espacio publicitario de prueba (placeholder)"
      title="Placeholder visible en desarrollo o sin consentimiento"
    >
      Placeholder de anuncio ({kind})
    </div>
  );
}
