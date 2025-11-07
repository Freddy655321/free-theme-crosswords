"use client";

import React from "react";

export default function AppShell({ children }: { children: React.ReactNode }) {
  // Versión mínima: sin Consent, sin Ads, sin hooks
  return <div className="min-h-screen">{children}</div>;
}
