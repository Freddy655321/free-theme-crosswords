// app/components/StickyAd.tsx
"use client";

import AdSlot from "./AdSlot";

const slotId = process.env.NEXT_PUBLIC_ADSENSE_SLOT_STICKY || ""; // opcional

export default function StickyAd() {
  if (!slotId) return null;
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 border-t bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/75">
      <div className="mx-auto max-w-5xl px-2 py-1">
        <AdSlot slot={slotId} format="auto" responsive />
      </div>
    </div>
  );
}
