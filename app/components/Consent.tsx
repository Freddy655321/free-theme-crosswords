// app/components/Consent.tsx
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type ConsentStatus = "unknown" | "accepted" | "rejected";

interface ConsentCtx {
  status: ConsentStatus;
  accept: () => void;
  reject: () => void;
  isProd: boolean;
  clientId: string | null;
  adsReady: boolean; // script cargado y window.adsbygoogle listo
}

const ConsentContext = createContext<ConsentCtx | null>(null);

declare global {
  interface Window {
    adsbygoogle?: Array<Record<string, unknown>>;
    __adsenseLoaded?: boolean;
  }
}

const CONSENT_KEY = "ftc-consent";
const isProdEnv = typeof process !== "undefined" && process.env.NODE_ENV === "production";
const clientIdEnv = (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_ADSENSE_CLIENT : undefined) || null;

export function ConsentProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConsentStatus>("unknown");
  const [adsReady, setAdsReady] = useState(false);

  // Lee consentimiento inicial del storage
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(CONSENT_KEY) as ConsentStatus | null;
    if (saved === "accepted" || saved === "rejected") setStatus(saved);
  }, []);

  const loadAdsScript = useCallback(() => {
    if (!isProdEnv) return;
    if (!clientIdEnv) return;
    if (typeof window === "undefined") return;
    if (window.__adsenseLoaded) {
      // ya cargado anteriormente
      setAdsReady(true);
      return;
    }

    const s = document.createElement("script");
    s.setAttribute("async", "");
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(
      clientIdEnv
    )}`;
    s.crossOrigin = "anonymous";
    s.onload = () => {
      window.adsbygoogle = window.adsbygoogle || [];
      window.__adsenseLoaded = true;
      setAdsReady(true);
    };
    s.onerror = () => {
      // no bloqueamos la app si falla
      setAdsReady(false);
    };
    document.head.appendChild(s);
  }, []);

  // Si ya aceptó, cargamos script
  useEffect(() => {
    if (status === "accepted") loadAdsScript();
  }, [status, loadAdsScript]);

  const accept = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CONSENT_KEY, "accepted");
    }
    setStatus("accepted");
  }, []);

  const reject = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CONSENT_KEY, "rejected");
    }
    setStatus("rejected");
  }, []);

  const value = useMemo<ConsentCtx>(
    () => ({
      status,
      accept,
      reject,
      isProd: isProdEnv,
      clientId: clientIdEnv,
      adsReady,
    }),
    [status, accept, reject, adsReady]
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

export function useConsent() {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error("useConsent must be used within ConsentProvider");
  return ctx;
}

// Banner simple pegajoso inferior
export function ConsentBanner() {
  const { status, accept, reject, isProd } = useConsent();

  // En desarrollo ocultamos el banner (no hace falta consent)
  if (!isProd) return null;
  if (status !== "unknown") return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 bg-white/95 border-t border-gray-200 shadow-sm">
      <div className="mx-auto max-w-5xl px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <p className="text-sm text-gray-700">
          Usamos cookies para personalizar contenido y medir el tráfico. ¿Aceptás el uso de cookies?
        </p>
        <div className="ml-auto flex gap-2">
          <button
            onClick={reject}
            className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
            type="button"
          >
            Rechazar
          </button>
          <button
            onClick={accept}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            type="button"
          >
            Aceptar
          </button>
        </div>
      </div>
    </div>
  );
}
