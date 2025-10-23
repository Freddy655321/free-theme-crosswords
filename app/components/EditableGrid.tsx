// app/components/EditableGrid.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCrosswordStore } from "../store/crosswordStore";
import type { Cell, Clue, Direction } from "../../types/puzzle";

const progressKey = (id: string) => `ftc-progress-${id}`;

export default function EditableGrid() {
  const {
    puzzle,
    selection,
    direction,
    setSelection,
    setDirection,
    toggleDirection,
    inputChar,
    move,
    hydrateFromChars,
    getChars,
  } = useCrosswordStore();

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Estado local para validaciones
  const [wrongKeys, setWrongKeys] = useState<Set<string>>(new Set()); // celdas incorrectas (rojo)

  // ==== PERSISTENCIA ====

  // Restaurar progreso guardado cuando cambia el puzzle
  useEffect(() => {
    if (!puzzle) return;
    try {
      const raw = localStorage.getItem(progressKey(puzzle.id));
      if (!raw) return;
      const data: {
        chars: string[];
        selection?: { row: number; col: number } | null;
        direction?: Direction;
      } = JSON.parse(raw);

      if (Array.isArray(data.chars)) {
        hydrateFromChars(data.chars);
      }
      if (data.selection) setSelection(data.selection);
      if (data.direction) setDirection(data.direction);
    } catch {
      // ignore parse errors
    }
    // solo al montar/cambiar puzzle.id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzle?.id]);

  // Autosave: guarda chars + selección + dirección ante cambios
  useEffect(() => {
    if (!puzzle) return;
    const payload = {
      chars: getChars(),
      selection,
      direction,
      // se puede usar para debug/borrado si querés
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(progressKey(puzzle.id), JSON.stringify(payload));
    } catch {
      // ignore quota errors
    }
  }, [puzzle, selection, direction, getChars]);

  // ====== RENDER GRID / LÓGICA DE JUEGO ======

  // Construcción de filas para render
  const rows: Cell[][] = useMemo(() => {
    if (!puzzle) return [];
    const r: Cell[][] = [];
    for (let y = 0; y < puzzle.height; y++) {
      r.push(puzzle.grid.slice(y * puzzle.width, (y + 1) * puzzle.width) as Cell[]);
    }
    return r;
  }, [puzzle]);

  // Acceso seguro a una celda
  const cellAt = useCallback(
    (r: number, c: number): Cell | null => {
      if (!puzzle) return null;
      if (r < 0 || c < 0 || r >= puzzle.height || c >= puzzle.width) return null;
      return puzzle.grid[r * puzzle.width + c] as Cell;
    },
    [puzzle]
  );

  // Ir al inicio de palabra desde una posición
  const findWordStart = useCallback(
    (row: number, col: number, dir: Direction): { row: number; col: number } => {
      let r = row;
      let c = col;
      if (dir === "across") {
        while (c - 1 >= 0 && !cellAt(r, c - 1)?.isBlock) c--;
      } else {
        while (r - 1 >= 0 && !cellAt(r - 1, c)?.isBlock) r--;
      }
      return { row: r, col: c };
    },
    [cellAt]
  );

  // Obtener todas las coordenadas de la palabra y su string actual
  const collectWord = useCallback(
    (row: number, col: number, dir: Direction) => {
      const coords: Array<{ row: number; col: number }> = [];
      let r = row;
      let c = col;

      if (!puzzle) return { coords, current: "" };

      if (dir === "across") {
        while (c < puzzle.width && !cellAt(r, c)?.isBlock) {
          coords.push({ row: r, col: c });
          c++;
        }
      } else {
        while (r < puzzle.height && !cellAt(r, c)?.isBlock) {
          coords.push({ row: r, col: c });
          r++;
        }
      }

      const current = coords
        .map(({ row: rr, col: cc }) => (cellAt(rr, cc)?.char ?? ""))
        .join("")
        .toUpperCase();

      return { coords, current };
    },
    [cellAt, puzzle]
  );

  // Buscar la pista (Clue) en base al número de la celda de inicio
  const findClue = useCallback(
    (row: number, col: number, dir: Direction): Clue | null => {
      if (!puzzle) return null;
      const start = findWordStart(row, col, dir);
      const startCell = cellAt(start.row, start.col);
      const number = startCell?.number;
      if (!number && number !== 0) return null;
      const clue = puzzle.clues.find(
        (c) => c.direction === dir && c.number === number
      );
      return clue ?? null;
    },
    [puzzle, findWordStart, cellAt]
  );

  // Celdas de la palabra activa (principal)
  const activeSet = useMemo(() => {
    const set = new Set<string>();
    if (!puzzle || !selection) return set;

    const start = findWordStart(selection.row, selection.col, direction);
    const { coords } = collectWord(start.row, start.col, direction);
    coords.forEach(({ row, col }) => set.add(`${row}-${col}`));
    return set;
  }, [puzzle, selection, direction, findWordStart, collectWord]);

  // Celdas de la pista opuesta (resaltado secundario)
  const oppositeSet = useMemo(() => {
    const set = new Set<string>();
    if (!puzzle || !selection) return set;
    const opposite: Direction = direction === "across" ? "down" : "across";
    const startOpp = findWordStart(selection.row, selection.col, opposite);
    const { coords } = collectWord(startOpp.row, startOpp.col, opposite);
    coords.forEach(({ row, col }) => set.add(`${row}-${col}`));
    return set;
  }, [puzzle, selection, direction, collectWord, findWordStart]);

  // === Acciones de validación ===

  const checkActiveWord = useCallback(() => {
    if (!puzzle || !selection) return;
    const start = findWordStart(selection.row, selection.col, direction);
    const { coords, current } = collectWord(start.row, start.col, direction);
    const clue = findClue(selection.row, selection.col, direction);
    if (!clue) return;

    const nextWrong = new Set(wrongKeys);
    coords.forEach((coord, i) => {
      const correctChar = clue.answer[i]?.toUpperCase() ?? "";
      const curChar = current[i] ?? "";
      const key = `${coord.row}-${coord.col}`;
      if (correctChar && curChar !== correctChar) nextWrong.add(key);
      else nextWrong.delete(key);
    });
    setWrongKeys(nextWrong);
  }, [puzzle, selection, direction, findWordStart, collectWord, findClue, wrongKeys]);

  const checkBoard = useCallback(() => {
    if (!puzzle) return;
    const nextWrong = new Set<string>();

    const process = (dir: Direction) => {
      const clues = puzzle.clues.filter((c) => c.direction === dir);
      for (const clue of clues) {
        const startCellIndex = puzzle.grid.findIndex(
          (cell) => cell.number === clue.number
        );
        if (startCellIndex === -1) continue;
        const startRow = Math.floor(startCellIndex / puzzle.width);
        const startCol = startCellIndex % puzzle.width;

        const { coords } = collectWord(startRow, startCol, dir);
        coords.forEach((coord, i) => {
          const correct = clue.answer[i]?.toUpperCase() ?? "";
          const current = cellAt(coord.row, coord.col)?.char?.toUpperCase() ?? "";
          if (correct && current !== correct) {
            nextWrong.add(`${coord.row}-${coord.col}`);
          }
        });
      }
    };

    process("across");
    process("down");
    setWrongKeys(nextWrong);
  }, [puzzle, collectWord, cellAt]);

  const revealActiveWord = useCallback(() => {
    if (!puzzle || !selection) return;
    const start = findWordStart(selection.row, selection.col, direction);
    const clue = findClue(selection.row, selection.col, direction);
    if (!clue) return;

    // Posicionamos la selección al inicio de la palabra
    setSelection({ row: start.row, col: start.col });

    const letters = clue.answer.toUpperCase().split("");
    const isAcross = direction === "across";

    for (let i = 0; i < letters.length; i++) {
      inputChar(letters[i] ?? "");
      if (i < letters.length - 1) {
        if (isAcross) move(0, 1);
        else move(1, 0);
      }
    }

    // Limpiamos errores de esa palabra
    const { coords } = collectWord(start.row, start.col, direction);
    const cleaned = new Set(wrongKeys);
    coords.forEach(({ row, col }) => cleaned.delete(`${row}-${col}`));
    setWrongKeys(cleaned);
  }, [
    puzzle,
    selection,
    direction,
    findWordStart,
    findClue,
    setSelection,
    inputChar,
    move,
    collectWord,
    wrongKeys,
  ]);

  // Control de teclado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!puzzle || !selection) return;

      const key = e.key;
      if (key.length === 1 && /^[a-zA-Z]$/.test(key)) {
        e.preventDefault();
        inputChar(key);
        return;
      }
      if (key === "Backspace") {
        e.preventDefault();
        inputChar("");
        return;
      }
      if (key === " ") {
        e.preventDefault();
        toggleDirection();
        return;
      }
      if (key === "ArrowLeft") {
        e.preventDefault();
        move(0, -1);
      } else if (key === "ArrowRight") {
        e.preventDefault();
        move(0, 1);
      } else if (key === "ArrowUp") {
        e.preventDefault();
        move(-1, 0);
      } else if (key === "ArrowDown") {
        e.preventDefault();
        move(1, 0);
      }
    };

    const el = containerRef.current;
    el?.addEventListener("keydown", onKey);
    return () => el?.removeEventListener("keydown", onKey);
  }, [puzzle, selection, inputChar, move, toggleDirection]);

  if (!puzzle) return null;

  return (
    <div className="space-y-3">
      {/* Barra de acciones */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={checkActiveWord}
          className="px-3 py-1 rounded border text-sm hover:bg-gray-50"
        >
          Check palabra
        </button>
        <button
          type="button"
          onClick={checkBoard}
          className="px-3 py-1 rounded border text-sm hover:bg-gray-50"
        >
          Check tablero
        </button>
        <button
          type="button"
          onClick={revealActiveWord}
          className="px-3 py-1 rounded border text-sm hover:bg-gray-50"
        >
          Reveal palabra
        </button>
        <div className="ml-auto text-sm text-gray-600">
          Dirección: <span className="font-medium">{direction.toUpperCase()}</span>{" "}
          <span className="ml-2 opacity-70">(Espacio cambia dirección)</span>
        </div>
      </div>

      {/* Grid */}
      <div
        ref={containerRef}
        tabIndex={0}
        className="outline-none inline-grid select-none"
        style={{ gridTemplateColumns: `repeat(${puzzle.width}, 2rem)` }}
        aria-label="Crossword grid"
      >
        {rows.flat().map((cell) => {
          const isSel =
            selection && selection.row === cell.row && selection.col === cell.col;
          const key = `${cell.row}-${cell.col}`;
          const isWrong = wrongKeys.has(key);
          const isActiveWord = activeSet.has(key);
          const isOppositeWord = oppositeSet.has(key);

          // Prioridad: error > selección > palabra activa > opuesta > normal
          let classes =
            "relative h-8 w-8 border flex items-center justify-center text-sm font-semibold ";
          if (cell.isBlock) {
            classes += "bg-gray-800 border-gray-700 text-transparent";
          } else if (isWrong) {
            classes += "bg-red-100 border-red-300";
          } else if (isSel) {
            classes += "ring-2 ring-blue-500 bg-blue-100 border-gray-300";
          } else if (isActiveWord) {
            classes += "bg-blue-50 border-gray-300";
          } else if (isOppositeWord) {
            classes += "bg-yellow-50 border-gray-300";
          } else {
            classes += "bg-white border-gray-300";
          }

          return (
            <div
              key={key}
              onClick={() => setSelection({ row: cell.row, col: cell.col })}
              className={classes}
            >
              {!cell.isBlock && cell.number ? (
                <span className="absolute left-0.5 top-0.5 text-[10px] text-gray-500">
                  {cell.number}
                </span>
              ) : null}
              {!cell.isBlock ? (cell.char || "") : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
