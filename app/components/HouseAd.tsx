"use client";

type Kind = "leader" | "rect" | "square";

/**
 * Versión neutra de HouseAd: no importa Consent ni carga ads.
 * Renderiza un placeholder liviano que NO bloquea el build.
 */
export default function HouseAd({ kind = "rect" }: { kind?: Kind }) {
  const ratio =
    kind === "leader" ? "6 / 1" : kind === "square" ? "1 / 1" : "4 / 3";

  return (
    <div
      aria-hidden
      className="w-full rounded-xl border border-dashed border-gray-300 text-gray-400 text-sm grid place-items-center"
      style={{ aspectRatio: ratio }}
    >
      Placeholder de anuncio ({kind})
    </div>
  );
}
