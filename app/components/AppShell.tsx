// app/components/AppShell.tsx
"use client";

import React from "react";
import Consent from "./Consent";

export default function AppShell({ children }: { children: React.ReactNode }) {
  // Sin anuncios en esta versión: evitamos overlays que tapen la UI
  return (
    <>
      <Consent />
      <div className="min-h-screen">{children}</div>
    </>
  );
}
