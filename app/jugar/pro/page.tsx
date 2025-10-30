// app/jugar/pro/page.tsx
"use client";

import { useEffect } from "react";
import { useCrosswordStore } from "../../store/crosswordStore";
import EditableGrid from "../../components/EditableGrid";
import ClueList from "../../components/ClueList";
import AdSlot from "../../components/AdSlot";
import HouseAd from "../../components/HouseAd";

export default function Page() {
  const {
    puzzle,
    loadFromQuickplay,
    loadFromGenerated,
  } = useCrosswordStore();

  // Slots opcionales (solo renderizan si existen y hay consentimiento en prod)
  const slotLeader =
    (process.env.NEXT_PUBLIC_ADSENSE_SLOT_LEADER as string | undefined) || "";

  useEffect(() => {
    // Si venimos de /generar, habrá un payload en sessionStorage.
    const raw = typeof window !== "undefined" ? sessionStorage.getItem("lastGenerated") : null;
    if (raw) {
      try {
        const payload = JSON.parse(raw);
        loadFromGenerated(payload);
        // No limpiamos automáticamente para permitir refrescos de página; si querés, podés limpiar acá.
        return;
      } catch {
        // Si falla el parse, caemos al quickplay.
      }
    }
    // Fallback: quickplay existente
    loadFromQuickplay();
  }, [loadFromGenerated, loadFromQuickplay]);

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Jugar (Pro)</h1>

      {/* Anuncio superior */}
      {slotLeader ? <AdSlot slot={slotLeader} className="my-2" /> : null}
      {/* Fallback visible en dev o sin consentimiento */}
      <HouseAd kind="leader" />

      {!puzzle ? (
        <p>
          No hay puzzle cargado. Generá uno en <code>/generar</code> y volvé.
        </p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <EditableGrid />
          <ClueList puzzle={puzzle} />
        </div>
      )}
    </main>
  );
}
