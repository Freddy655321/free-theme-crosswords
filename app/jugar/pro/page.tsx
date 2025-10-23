// app/jugar/pro/page.tsx
"use client";

import { useEffect } from "react";
import { useCrosswordStore } from "../../store/crosswordStore";
import EditableGrid from "../../components/EditableGrid";
import ClueList from "../../components/ClueList";
import AdSlot from "../../components/AdSlot";

export default function Page() {
  const { puzzle, loadFromQuickplay } = useCrosswordStore();

  // Slots opcionales (solo renderizan si existen y hay consentimiento en prod)
  const slotLeader =
    (process.env.NEXT_PUBLIC_ADSENSE_SLOT_LEADER as string | undefined) || "";

  useEffect(() => {
    loadFromQuickplay();
  }, [loadFromQuickplay]);

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Jugar (Pro)</h1>

      {/* Leaderboard superior (gateado por consentimiento en AdSlot) */}
      {slotLeader ? (
        <AdSlot slot={slotLeader} className="my-2" format="auto" responsive />
      ) : null}

      {!puzzle ? (
        <p>
          No hay puzzle cargado. Generá uno en <code>/generar</code> y volvé.
        </p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <EditableGrid />
          {/* ClueList sigue consumiendo el puzzle pasado como prop para no tocarlo aún */}
          <ClueList puzzle={puzzle} />
        </div>
      )}
    </main>
  );
}
