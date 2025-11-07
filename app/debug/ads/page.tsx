"use client";

// Evita prerender y cualquier hook de consentimiento en build.
export const dynamic = "force-dynamic";

export default function AdsDebugPage() {
  // En producción, esta página solo muestra un mensaje seguro.
  if (process.env.NODE_ENV === "production") {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-xl font-semibold mb-2">Debug de anuncios</h1>
        <p className="text-gray-700">
          La vista de debug está deshabilitada en producción para evitar errores de
          prerender. Usala solo en desarrollo.
        </p>
      </main>
    );
  }

  // 🧪 Si querés, podés dejar acá tu UI de pruebas para DEV.
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold mb-2">Debug de anuncios (DEV)</h1>
      <p className="text-gray-700">
        Ambiente de desarrollo. Agregá aquí tus pruebas de Consent/Ads.
      </p>
    </main>
  );
}
