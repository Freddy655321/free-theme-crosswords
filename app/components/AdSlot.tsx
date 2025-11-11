'use client';

import { useRef } from 'react';
import { usePathname } from 'next/navigation';

type Props = {
  /** Formato visual del placeholder (solo decorativo por ahora) */
  format?: 'rect' | 'banner' | 'square';
};

/**
 * AdSlot (placeholder)
 * - Sin lógica de consentimiento ni carga de scripts.
 * - No se muestra en la vista de QA (/jugar/preview).
 * - Mantiene un placeholder visualmente neutro.
 */
export default function AdSlot({ format = 'rect' }: Props) {
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);

  // Ocultamos el slot en la vista de QA
  const isPreview = pathname?.startsWith('/jugar/preview') ?? false;
  if (isPreview) return null;

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="rounded-xl border border-dashed border-zinc-300 text-zinc-400 text-sm grid place-items-center h-40"
    >
      Placeholder de anuncio ({format})
    </div>
  );
}
