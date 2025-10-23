// app/components/AdSlot.tsx
"use client";

import { useEffect, useRef } from "react";
import { useConsent } from "./Consent";

type Props = {
  /** Slot numérico asignado por AdSense, ej.: "1234567890" */
  slot: string;
  /** width/height inline si querés forzar tamaños; si se omite, usa responsive auto */
  style?: React.CSSProperties;
  className?: string;
  /** formato adsense */
  format?: "auto" | "fluid" | "rectangle";
  /** responsive */
  responsive?: boolean;
};

export default function AdSlot({
  slot,
  style,
  className,
  format = "auto",
  responsive = true,
}: Props) {
  const { status, isProd, adsReady, clientId } = useConsent();
  const insRef = useRef<HTMLModElement | null>(null);

  const canShow = isProd && status === "accepted" && adsReady && !!clientId;

  useEffect(() => {
    if (!canShow) return;
    if (typeof window === "undefined") return;

    try {
      // Usa la declaración global definida en Consent.tsx (no redeclaramos acá)
      window.adsbygoogle = window.adsbygoogle || [];
      window.adsbygoogle.push({});
    } catch {
      // silencioso: si falla no rompemos la UI
    }
  }, [canShow, slot, format, responsive]);

  if (!canShow) return null;

  return (
    <ins
      ref={insRef}
      className={`adsbygoogle block ${className ?? ""}`}
      style={style ?? { display: "block" }}
      data-ad-client={clientId!}
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive={responsive ? "true" : "false"}
    />
  );
}
