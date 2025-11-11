"use client";

/**
 * Versión neutra de AdSlot: sin Consent ni scripts de ads.
 */
export default function AdSlot() {
  return (
    <div
      aria-hidden
      className="w-full rounded-xl border border-dashed border-gray-300 text-gray-400 text-xs grid place-items-center"
      style={{ aspectRatio: "4 / 3" }}
    >
      Placeholder de anuncio
    </div>
  );
}
