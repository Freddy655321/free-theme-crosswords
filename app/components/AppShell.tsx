"use client";

import React from "react";

export default function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  // Versión segura: sin imports dinámicos, sin Consent
  return <main className="min-h-screen">{children}</main>;
}
