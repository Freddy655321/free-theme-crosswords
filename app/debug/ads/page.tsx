// app/debug/ads/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useConsent } from "../../components/Consent";
import AdSlot from "../../components/AdSlot";

export default function DebugAdsPage() {
  const { status, accept, reject, isProd, clientId, adsReady } = useConsent();
  const [envs] = useState({
    client: process.env.NEXT_PUBLIC_ADSENSE_CLIENT || "",
    leader: process.env.NEXT_PUBLIC_ADSENSE_SLOT_LEADER || "",
    rect: process.env.NEXT_PUBLIC_ADSENSE_SLOT_RECT || "",
    sticky: process.env.NEXT_PUBLIC_ADSENSE_SLOT_STICKY || "",
  });

  const clearConsent = () => {
    try {
      localStorage.removeItem("ftc-consent");
    } catch {}
    location.reload();
  };

  useEffect(() => {}, [status, adsReady]);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Debug Ads / Consent</h1>

      <section className="rounded border p-4">
        <h2 className="font-semibold mb-2">Estado</h2>
        <ul className="text-sm space-y-1">
          <li><span className="font-medium">isProd:</span> {String(isProd)}</li>
          <li><span className="font-medium">consent status:</span> {status}</li>
          <li><span className="font-medium">adsReady:</span> {String(adsReady)}</li>
          <li><span className="font-medium">clientId:</span> {clientId || "(vacío)"}</li>
        </ul>
        <div className="mt-3 flex gap-2">
          <button onClick={accept} className="px-3 py-1.5 rounded bg-blue-600 text-white">Aceptar cookies</button>
          <button onClick={reject} className="px-3 py-1.5 rounded border">Rechazar cookies</button>
          <button onClick={clearConsent} className="px-3 py-1.5 rounded border">Limpiar consentimiento</button>
        </div>
      </section>

      <section className="rounded border p-4">
        <h2 className="font-semibold mb-2">ENV (Next Public)</h2>
        <ul className="text-sm space-y-1">
          <li><span className="font-medium">NEXT_PUBLIC_ADSENSE_CLIENT:</span> {envs.client || "(vacío)"}</li>
          <li><span className="font-medium">LEADER:</span> {envs.leader || "(vacío)"}</li>
          <li><span className="font-medium">RECT:</span> {envs.rect || "(vacío)"}</li>
          <li><span className="font-medium">STICKY:</span> {envs.sticky || "(vacío)"}</li>
        </ul>
      </section>

      <section className="rounded border p-4">
        <h2 className="font-semibold mb-2">Slots de prueba</h2>
        <div className="space-y-3">
          {envs.leader ? <AdSlot slot={envs.leader} /> : <p className="text-sm text-gray-500">LEADER vacío</p>}
          {envs.rect ? <AdSlot slot={envs.rect} /> : <p className="text-sm text-gray-500">RECT vacío</p>}
          {envs.sticky ? (
            <p className="text-sm text-gray-600">El sticky aparece globalmente si hay consentimiento.</p>
          ) : (
            <p className="text-sm text-gray-500">STICKY vacío</p>
          )}
        </div>
      </section>
    </main>
  );
}
