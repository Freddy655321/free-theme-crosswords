// app/debug/ads/page.tsx
"use client";

import { useConsent } from "../../components/Consent";

export default function DebugAdsPage() {
  const { status, accept, reject, isProd, clientId, adsReady } = useConsent();

  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Debug Ads / Consent</h1>

      <section className="border rounded p-4 space-y-2">
        <p><strong>isProd:</strong> {String(isProd)}</p>
        <p><strong>consent status:</strong> {status}</p>
        <p><strong>adsReady:</strong> {String(adsReady)}</p>
        <p><strong>clientId:</strong> {clientId || "(vacío)"}</p>

        <div className="flex gap-2">
          <button
            onClick={accept}
            className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Aceptar cookies
          </button>
          <button
            onClick={reject}
            className="px-3 py-1.5 border rounded hover:bg-gray-50"
          >
            Rechazar cookies
          </button>
          <button
            onClick={() => {
              localStorage.removeItem("ftc-consent");
              location.reload();
            }}
            className="px-3 py-1.5 border rounded hover:bg-gray-50"
          >
            Limpiar consentimiento
          </button>
        </div>
      </section>

      <section className="border rounded p-4 space-y-2">
        <h2 className="font-semibold text-lg">ENV (Next Public)</h2>
        <p>
          <strong>NEXT_PUBLIC_ADSENSE_CLIENT:</strong>{" "}
          {process.env.NEXT_PUBLIC_ADSENSE_CLIENT || "(vacío)"}
        </p>
        <p>
          <strong>LEADER:</strong>{" "}
          {process.env.NEXT_PUBLIC_ADSENSE_SLOT_LEADER || "(vacío)"}
        </p>
        <p>
          <strong>RECT:</strong>{" "}
          {process.env.NEXT_PUBLIC_ADSENSE_SLOT_RECT || "(vacío)"}
        </p>
        <p>
          <strong>STICKY:</strong>{" "}
          {process.env.NEXT_PUBLIC_ADSENSE_SLOT_STICKY || "(vacío)"}
        </p>
      </section>

      <section className="border rounded p-4 space-y-2">
        <h2 className="font-semibold text-lg">Slots de prueba</h2>
        <p>El sticky aparece globalmente si hay consentimiento.</p>
      </section>
    </main>
  );
}
