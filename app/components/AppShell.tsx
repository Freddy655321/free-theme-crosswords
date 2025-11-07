// app/components/AppShell.tsx
"use client";

import React from "react";

/** Tipado del módulo dinámico de Consent (soporta default o nombrado). */
type ConsentModule = {
  default?: React.ComponentType;
  Consent?: React.ComponentType;
};

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [ConsentComp, setConsentComp] = React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    let alive = true;
    import("./Consent")
      .then((mod: ConsentModule) => {
        const C = mod.default ?? mod.Consent ?? null;
        if (alive) setConsentComp(C);
      })
      .catch(() => {
        if (alive) setConsentComp(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      {ConsentComp ? <ConsentComp /> : null}
      <div className="min-h-screen">{children}</div>
    </>
  );
}
