// app/politica-cookies/page.tsx
export default function PoliticaCookiesPage() {
  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6 text-gray-800">
      <h1 className="text-3xl font-bold text-center">Política de Cookies</h1>

      <p className="text-base leading-relaxed">
        Usamos cookies para operar el sitio, recordar tus preferencias y medir el tráfico.
        Algunas cookies pueden ser provistas por terceros (por ejemplo, Google AdSense) para
        mostrar anuncios. Podés aceptar o rechazar el uso de cookies desde el banner de
        consentimiento cuando ingresás al sitio, o cambiar tu preferencia en cualquier momento.
      </p>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">Tipos de cookies</h2>
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Esenciales:</strong> necesarias para el funcionamiento básico del sitio.</li>
          <li><strong>Preferencias:</strong> guardan configuraciones como tema o idioma.</li>
          <li><strong>Medición:</strong> nos ayudan a entender el uso del sitio.</li>
          <li><strong>Publicidad:</strong> usadas por redes publicitarias (p. ej. Google AdSense) para anuncios relevantes.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-gray-900">Cómo gestionar tu consentimiento</h2>
        <p className="text-base leading-relaxed">
          Podés aceptar o rechazar las cookies desde el banner que aparece al ingresar.
          Si querés cambiar tu elección, visitá{" "}
          <a href="/debug/ads" className="underline text-blue-600 hover:text-blue-700">
            /debug/ads
          </a>{" "}
          y usá los botones “Aceptar cookies” o “Rechazar cookies”.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-gray-900">Más información sobre Google AdSense</h2>
        <p className="text-base leading-relaxed">
          Google puede usar cookies y tecnologías similares para personalizar anuncios y medir
          su rendimiento. Para más detalles, consultá la{" "}
          <a
            href="https://policies.google.com/technologies/ads"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-blue-600 hover:text-blue-700"
          >
            documentación oficial de Google
          </a>
          .
        </p>
      </section>
    </main>
  );
}
