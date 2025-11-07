// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";
import React from "react";
import AppShell from "./components/AppShell";

export const metadata: Metadata = {
  title: "Free Theme Crosswords",
  description: "Crucigramas temáticos gratis — juega en web y móvil.",
  metadataBase: new URL("https://free-theme-crosswords.vercel.app"),
  alternates: { canonical: "/" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-white text-black">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
