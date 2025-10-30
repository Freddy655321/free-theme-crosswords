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
  adsReady: boolean;
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
const clientIdEnv =
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_ADSENSE_CLIENT : undefined) || null;

export function ConsentProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConsentStatus>("unknown");
  const [adsReady, setAdsReady] = useState(false);

  // Leer preferencia guardada
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(CONSENT_KEY) as ConsentStatus | null;
    if (saved === "accepted" || saved === "rejected") setStatus(saved);
  }, []);

  // Cargar script de AdSense SOLO en producción y con consentimiento aceptado
  const loadAdsScript = useCallback(() => {
    if (!isProdEnv || !clientIdEnv || typeof window === "undefined") return;
    if (window.__adsenseLoaded) {
      setAdsReady(true);
      return;
    }
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(
      clientIdEnv
    )}`;
    s.crossOrigin = "anonymous";
    s.onload = () => {
      window.adsbygoogle = window.adsbygoogle || [];
      window.__adsenseLoaded = true;
      setAdsReady(true);
    };
    s.onerror = () => setAdsReady(false);
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (status === "accepted") loadAdsScript();
  }, [status, loadAdsScript]);

  const accept = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(CONSENT_KEY, "accepted");
    setStatus("accepted");
  }, []);

  const reject = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(CONSENT_KEY, "rejected");
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

export function ConsentBanner() {
  const { status, accept, reject, isProd } = useConsent();

  // En desarrollo no mostramos banner; solo en producción.
  if (!isProd) return null;
  if (status !== "unknown") return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 bg-white/95 border-t border-gray-200 shadow-sm">
      <div className="mx-auto max-w-5xl px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <p className="text-sm text-gray-700">
          Usamos cookies para personalizar contenido y medir el tráfico.{" "}
          <a
            href="/politica-cookies"
            className="underline text-blue-600 hover:text-blue-700"
          >
            Más info
          </a>
          .
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
