// components/ThemeToggle.tsx
"use client";
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean>(false);

  useEffect(() => {
    const saved = localStorage.getItem("theme-dark");
    const isDark = saved ? saved === "1" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme-dark", next ? "1" : "0");
  };

  return (
    <button
      onClick={toggle}
      className="rounded-xl border border-neutral-300/60 dark:border-neutral-700/60 px-3 py-1 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
      aria-label="Alternar tema"
      title="Alternar tema"
    >
      {dark ? "🌙 Oscuro" : "☀️ Claro"}
    </button>
  );
}
