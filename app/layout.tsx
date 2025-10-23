// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";
import { ConsentProvider, ConsentBanner } from "./components/Consent";
import StickyAd from "./components/StickyAd";

export const metadata: Metadata = {
  title: "Free Theme Crosswords",
  description: "Generá y jugá crucigramas temáticos online.",
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        <ConsentProvider>
          {/* Banner de consentimiento (solo en producción y mientras esté 'unknown') */}
          <ConsentBanner />
          {/* Contenido de la app */}
          <div className="pb-14">{children}</div>
          {/* Sticky ad inferior: solo si configurás NEXT_PUBLIC_ADSENSE_SLOT_STICKY */}
          <StickyAd />
        </ConsentProvider>
      </body>
    </html>
  );
}
