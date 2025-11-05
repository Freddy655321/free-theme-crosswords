// /app/jugar/pro/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Crossword, Grid, Entry } from "../../../lib/crossword";
import Link from "next/link";

const PUZZLE_LS_KEY = "generatedCrossword";

// Clave única para guardar progreso del puzzle actual
function progressKey(p: Crossword) {
  return `ftc:progress:${p.language}:${p.size}:${p.title}`;
}

type Dir = "across" | "down";

// Tip auxiliar para evitar @ts-ignore/@ts-expect-error con Web Share API
type NavigatorWithShare = Navigator & {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
};

function groupEntries(entries: Entry[]) {
  const across = entries.filter(e => e.direction === "across").sort((a,b)=>a.number-b.number);
  const down   = entries.filter(e => e.direction === "down").sort((a,b)=>a.number-b.number);
  return { across, down };
}

function entryCoords(e: Entry) {
  const coords: Array<{r:number;c:number}> = [];
  for (let i=0; i<e.answer.length; i++) {
    coords.push({
      r: e.direction === "across" ? e.row : e.row + i,
      c: e.direction === "across" ? e.col + i : e.col,
    });
  }
  return coords;
}

function keyOf(r:number,c:number){ return `${r}-${c}`; }

export default function ProGamePage() {
  const [puzzle, setPuzzle] = useState<Crossword | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Juego
  const [board, setBoard] = useState<Grid>([]);
  const [active, setActive] = useState<{ number: number; direction: Dir } | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const [checked, setChecked] = useState<{ wrong: number; missing: number; solved: boolean } | null>(null);

  // Modal victoria & share
  const [winOpen, setWinOpen] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  // refs
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  // Cargar puzzle desde sessionStorage
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(PUZZLE_LS_KEY);
      if (!raw) { setError("No hay puzzle cargado. Generá uno desde /generar."); return; }
      const parsed = JSON.parse(raw) as Crossword;
      setPuzzle(parsed);
    } catch {
      setError("No se pudo leer el crucigrama desde el navegador.");
    }
  }, []);

  // Inicializar tablero (intentando restaurar progreso guardado)
  useEffect(() => {
    if (!puzzle?.grid) return;

    const empty: Grid = puzzle.grid.map(row => row.map(cell => (cell === "#" ? "#" : "")));

    try {
      const savedRaw = localStorage.getItem(progressKey(puzzle));
      if (savedRaw) {
        const saved = JSON.parse(savedRaw) as { board: Grid; size: number };
        const sameShape =
          saved?.size === puzzle.size &&
          Array.isArray(saved.board) &&
          saved.board.length === puzzle.grid.length &&
          saved.board.every((row, i) => Array.isArray(row) && row.length === puzzle.grid[i].length);

        setBoard(sameShape ? saved.board : empty);
      } else {
        setBoard(empty);
      }
    } catch {
      setBoard(empty);
    }

    setActive(null);
    setShowSolution(false);
    setChecked(null);
    setWinOpen(false);
  }, [puzzle]);

  const size = puzzle?.size ?? puzzle?.grid?.length ?? 0;
  const grid: Grid = puzzle?.grid ?? [];
  const { across, down } = useMemo(
    () => puzzle?.entries ? groupEntries(puzzle.entries) : { across: [], down: [] },
    [puzzle]
  );

  // Celdas resaltadas por pista activa
  const highlighted = useMemo(() => {
    if (!puzzle || !active) return new Set<string>();
    const e = puzzle.entries.find(en => en.number === active.number && en.direction === active.direction);
    if (!e) return new Set<string>();
    const k = new Set<string>();
    for (const {r,c} of entryCoords(e)) k.add(keyOf(r,c));
    return k;
  }, [puzzle, active]);

  // Persistencia: auto-guardado
  useEffect(() => {
    if (!puzzle || !board.length) return;
    try {
      localStorage.setItem(progressKey(puzzle), JSON.stringify({ board, size: puzzle.size, t: Date.now() }));
    } catch { /* ignore */ }
  }, [board, puzzle]);

  // ---- Helpers de interacción ----
  function focusInEntry(offset: number) {
    if (!puzzle || !active) return;
    const e = puzzle.entries.find(en => en.number === active.number && en.direction === active.direction);
    if (!e) return;
    const coords = entryCoords(e);
    let idx = coords.findIndex(({r,c}) => inputRefs.current.get(keyOf(r,c)) === document.activeElement);
    if (idx === -1) idx = 0;
    const nextIdx = Math.max(0, Math.min(coords.length-1, idx + offset));
    const {r,c} = coords[nextIdx];
    inputRefs.current.get(keyOf(r,c))?.focus();
  }

  function setCell(r:number,c:number, ch:string){
    setBoard(prev => {
      const next = prev.map(row => row.slice());
      next[r][c] = ch;
      return next;
    });
    setChecked(null);
  }

  function onKey(r:number,c:number, e:React.KeyboardEvent<HTMLInputElement>) {
    const isBlock = grid[r][c] === "#";
    if (isBlock) return;

    const letter = e.key.length === 1 ? e.key : "";

    if (/^[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]$/.test(letter)) {
      setCell(r,c,letter.toUpperCase());
      e.preventDefault();
      focusInEntry(1);
      return;
    }
    switch (e.key) {
      case "Enter":
        checkBoard(true);
        e.preventDefault();
        break;
      case "Backspace":
        if (board[r][c]) setCell(r,c,"");
        else focusInEntry(-1);
        e.preventDefault();
        break;
      case "ArrowRight":
        setActiveFromCell(r,c,"across");
        moveFocus(r,c,0,1);
        e.preventDefault();
        break;
      case "ArrowLeft":
        setActiveFromCell(r,c,"across");
        moveFocus(r,c,0,-1);
        e.preventDefault();
        break;
      case "ArrowDown":
        setActiveFromCell(r,c,"down");
        moveFocus(r,c,1,0);
        e.preventDefault();
        break;
      case "ArrowUp":
        setActiveFromCell(r,c,"down");
        moveFocus(r,c,-1,0);
        e.preventDefault();
        break;
      case "Tab":
        cycleEntry(e.shiftKey ? -1 : 1);
        e.preventDefault();
        break;
      case " ":
        toggleDirectionAt(r,c);
        e.preventDefault();
        break;
    }
  }

  function setActiveFromCell(r:number,c:number, prefer:Dir){
    if (!puzzle) return;
    const starts = puzzle.entries.filter(e => e.row===r && e.col===c);
    if (starts.length) {
      const found = starts.find(e => e.direction===prefer) ?? starts[0];
      setActive({ number: found.number, direction: found.direction });
      return;
    }
    const containing = puzzle.entries.find(e => entryCoords(e).some(p=>p.r===r&&p.c===c && grid[r][c]!=="#"));
    if (containing) setActive({ number: containing.number, direction: containing.direction });
  }

  function moveFocus(r:number,c:number, dr:number, dc:number){
    let nr=r, nc=c;
    while (nr>=0 && nr<size && nc>=0 && nc<size) {
      nr += dr; nc += dc;
      if (nr<0||nr>=size||nc<0||nc>=size) break;
      if (grid[nr][nc] !== "#") { inputRefs.current.get(keyOf(nr,nc))?.focus(); break; }
    }
  }

  function cycleEntry(dir:number){
    if (!puzzle) return;
    const list = active?.direction==="down" ? down : across;
    if (!list.length) return;
    let idx = active ? list.findIndex(e => e.number===active.number) : -1;
    idx = (idx + dir + list.length) % list.length;
    setActive({ number: list[idx].number, direction: list[idx].direction });
    const first = entryCoords(list[idx])[0];
    setTimeout(() => inputRefs.current.get(keyOf(first.r,first.c))?.focus(), 0);
  }

  function toggleDirectionAt(r:number,c:number){
    if (!puzzle) return;
    const both = puzzle.entries.filter(e => entryCoords(e).some(p=>p.r===r && p.c===c));
    if (both.length>=2) {
      const other = both.find(e => e.direction !== active?.direction) ?? both[0];
      setActive({ number: other.number, direction: other.direction });
    }
  }

  // ---- Verificación de victoria/errores ----
  function computeCheck() {
    if (!puzzle) return { wrong: 0, missing: 0, solved: false };

    let wrong = 0;
    let missing = 0;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (grid[r][c] === "#") continue;

        const user = (board[r]?.[c] ?? "").toUpperCase();
        const letters: string[] = [];
        for (const e of puzzle.entries) {
          const coords = entryCoords(e);
          const idx = coords.findIndex(p => p.r === r && p.c === c);
          if (idx >= 0) letters.push(e.answer[idx]?.toUpperCase() ?? "");
        }
        const expected = letters.find(Boolean) ?? "";
        if (!user) { missing++; continue; }
        if (expected && user !== expected) wrong++;
      }
    }
    return { wrong, missing, solved: wrong === 0 && missing === 0 };
  }

  function checkBoard(openModal = false) {
    const res = computeCheck();
    setChecked(res);
    if (res.solved && openModal) setWinOpen(true);
    return res;
  }

  function revealSolution(){
    if (!puzzle) return;
    const next: Grid = puzzle.grid.map(row => row.map(cell => (cell === "#" ? "#" : "")));
    for (const e of puzzle.entries) {
      const coords = entryCoords(e);
      coords.forEach((pos, i) => {
        const ch = e.answer[i] ?? "";
        if (ch && next[pos.r][pos.c] !== "#") next[pos.r][pos.c] = ch.toUpperCase();
      });
    }
    setBoard(next);
    setShowSolution(true);
    setChecked(null);
  }

  function toggleSolution(){
    if (!puzzle) return;
    if (!showSolution) revealSolution();
    else {
      const empty: Grid = puzzle.grid.map(row => row.map(cell => (cell === "#" ? "#" : "")));
      setBoard(empty);
      setShowSolution(false);
      setChecked(null);
    }
  }

  function clearBoard(){
    if (!puzzle) return;
    const empty: Grid = puzzle.grid.map(row => row.map(cell => (cell === "#" ? "#" : "")));
    setBoard(empty);
    setChecked(null);
  }

  function clearProgress(){
    if (!puzzle) return;
    try { localStorage.removeItem(progressKey(puzzle)); } catch {/* ignore */}
    clearBoard();
  }

  // ---- Share helpers ----
  function buildShareText() {
    if (!puzzle) return "Crucigrama resuelto.";
    return `¡Completé el crucigrama! 🧩
“${puzzle.title}” · ${puzzle.language.toUpperCase()} · ${puzzle.size}×${puzzle.size}
Hecho con Free Theme Crosswords`;
  }

  async function shareResult() {
    const text = buildShareText();
    try {
      const nav = navigator as NavigatorWithShare;
      if (typeof nav.share === "function") {
        await nav.share({ text, title: "Free Theme Crosswords" });
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopyMsg("Resultado copiado al portapapeles.");
      setTimeout(() => setCopyMsg(null), 2000);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        setCopyMsg("Resultado copiado al portapapeles.");
        setTimeout(() => setCopyMsg(null), 2000);
      } catch {
        setCopyMsg("No se pudo compartir ni copiar. Probá manualmente.");
        setTimeout(() => setCopyMsg(null), 2500);
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-4">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{puzzle?.title ?? "Crucigrama"}</h1>
          <p className="text-sm text-gray-500">
            Idioma: {puzzle?.language ?? "—"} · Tamaño: {size || "—"}×{size || "—"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/generar" className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50">Generar otro</Link>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={clearBoard}>Vaciar tablero</button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={clearProgress}>Borrar progreso</button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={() => checkBoard(true)}>Comprobar</button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={toggleSolution}>
            {showSolution ? "Ocultar solución" : "Mostrar solución"}
          </button>
        </div>
      </header>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* Banner de estado */}
      {checked && (
        <div
          className={`mb-4 rounded-md border p-3 text-sm ${
            checked.solved
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-yellow-200 bg-yellow-50 text-yellow-800"
          }`}
        >
          {checked.solved
            ? "¡Completado! Todas las letras son correctas."
            : `Hay ${checked.missing} casillas vacías y ${checked.wrong} incorrectas.`}
        </div>
      )}

      {copyMsg && (
        <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800">
          {copyMsg}
        </div>
      )}

      {puzzle && (
        <div className="grid gap-6 md:grid-cols-[1fr_380px]">
          {/* GRID editable */}
          <div>
            <div className="grid border border-gray-200" style={{ gridTemplateColumns: `repeat(${size}, 32px)` }}>
              {Array.from({ length: size }).map((_, r) =>
                Array.from({ length: size }).map((__, c) => {
                  const isBlock = grid[r]?.[c] === "#";
                  const k = keyOf(r,c);
                  const isActive = highlighted.has(k);
                  return (
                    <div
                      key={k}
                      className={`relative flex h-8 w-8 items-center justify-center border ${isBlock? "bg-black border-gray-700":"bg-white border-gray-200"} ${isActive && !isBlock ? "ring-2 ring-blue-500 z-10":""}`}
                      onClick={() => setActiveFromCell(r,c,"across")}
                    >
                      {isBlock ? null : (
                        <input
                          ref={(el) => { if (el) inputRefs.current.set(k, el); }}
                          value={board[r]?.[c] ?? ""}
                          onChange={(e)=>{ const v = e.target.value.slice(-1).toUpperCase(); if (/^[A-ZÁÉÍÓÚÜÑ]$/i.test(v)) setCell(r,c,v.toUpperCase()); else if (v==="") setCell(r,c,""); }}
                          onKeyDown={(e)=>onKey(r,c,e)}
                          className="h-full w-full text-center font-semibold outline-none"
                          inputMode="text"
                          autoComplete="off"
                          maxLength={1}
                        />
                      )}
                      {/* Números de inicio */}
                      {!isBlock && puzzle.entries.some(e => e.row===r && e.col===c) && (
                        <span className="pointer-events-none absolute left-0 top-0 -translate-y-[2px] translate-x-[2px] text-[10px] text-gray-600">
                          {Math.min(...puzzle.entries.filter(e=>e.row===r && e.col===c).map(e=>e.number))}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Pistas con click para resaltar */}
          <aside className="max-h-[75vh] overflow-auto rounded-md border p-3">
            <h2 className="mb-2 text-lg font-semibold">Pistas</h2>
            <div className="grid grid-cols-1 gap-4">
              <ClueList
                title="Horizontales"
                items={across}
                isActive={(n)=>active?.direction==="across" && active?.number===n}
                onClick={(e)=>{
                  setActive({ number: e.number, direction: "across" });
                  const first = entryCoords(e)[0]; setTimeout(()=>inputRefs.current.get(keyOf(first.r,first.c))?.focus(),0);
                }}
              />
              <ClueList
                title="Verticales"
                items={down}
                isActive={(n)=>active?.direction==="down" && active?.number===n}
                onClick={(e)=>{
                  setActive({ number: e.number, direction: "down" });
                  const first = entryCoords(e)[0]; setTimeout(()=>inputRefs.current.get(keyOf(first.r,first.c))?.focus(),0);
                }}
              />
              <div className="mt-2 text-xs text-gray-500">
                Tip: escribí para avanzar, Backspace para retroceder, flechas para moverte, Tab para cambiar de pista, Espacio para alternar dirección en un cruce. Presioná Enter para comprobar.
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* MODAL de victoria */}
      {winOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setWinOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
            onClick={(e)=>e.stopPropagation()}
          >
            <h3 className="mb-1 text-xl font-bold">¡Crucigrama completado! 🎉</h3>
            <p className="mb-4 text-sm text-gray-600">
              “{puzzle?.title}” · {puzzle?.language?.toUpperCase()} · {size}×{size}
            </p>

            <div className="flex flex-col gap-2">
              <button
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                onClick={shareResult}
              >
                Compartir resultado
              </button>
              <Link
                href="/generar"
                className="w-full rounded-md border px-4 py-2 text-center text-sm hover:bg-gray-50"
                onClick={() => setWinOpen(false)}
              >
                Generar otro
              </Link>
              <button
                className="w-full rounded-md border px-4 py-2 text-sm hover:bg-gray-50"
                onClick={() => setWinOpen(false)}
              >
                Cerrar
              </button>
            </div>

            {copyMsg && (
              <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800">
                {copyMsg}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ClueList({
  title,
  items,
  isActive,
  onClick,
}: {
  title: string;
  items: Entry[];
  isActive: (n:number)=>boolean;
  onClick: (e:Entry)=>void;
}) {
  return (
    <div>
      <h3 className="mb-1 font-semibold">{title}</h3>
      <ul className="space-y-1 text-sm">
        {items.map((e) => {
          const activeClass = isActive(e.number) ? "font-semibold text-blue-700" : "hover:text-blue-700";
          return (
            <li key={`${title}-${e.number}`}>
              <button
                className={`w-full text-left transition ${activeClass}`}
                onClick={() => onClick(e)}
                title={`Ir a ${e.number}`}
              >
                <span className="inline-block w-6 text-right mr-2">{e.number}.</span>
                <span>{e.clue}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
