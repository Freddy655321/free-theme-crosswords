// app/components/ThemeToggle.tsx
"use client";
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("pref-dark");
    const initial = saved === "1";
    setDark(initial);
    document.documentElement.classList.toggle("dark", initial);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("pref-dark", next ? "1" : "0");
  };

  return (
    <button
      onClick={toggle}
      className="px-3 py-1 rounded border text-sm hover:bg-gray-100 dark:hover:bg-neutral-800"
      aria-label="Cambiar tema"
    >
      {dark ? "🌙 Oscuro" : "☀️ Claro"}
    </button>
  );
}
