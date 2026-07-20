type GeneratedEntry = {
  number: number;
  row: number;
  col: number;
  direction: "across" | "down";
  answer: string;
  clue: string;
};

type GeneratedCrossword = {
  size: number;
  grid: string[][];
  entries: GeneratedEntry[];
};

const weakClue =
  /\b(perhaps|might|may|could|current|currently|former|latest|today|associated with|related to|in the context of|first name or surname|entrada vinculada|referencia asociada|quizas|podria|actualmente|exintegrante)\b/i;

export function generatedCrosswordIssue(crossword: GeneratedCrossword): string | null {
  const { size, grid, entries } = crossword;
  if (size !== 11 || grid.length !== size || grid.some((row) => row.length !== size)) {
    return "La grilla no es 11x11.";
  }
  if (entries.length < 15) return "La grilla tiene menos de 15 entradas.";
  if (!entries.some((entry) => entry.direction === "across")) return "No hay horizontales.";
  if (!entries.some((entry) => entry.direction === "down")) return "No hay verticales.";

  const letterCells = grid.flat().filter((cell) => cell !== "#").length;
  if (letterCells / (size * size) < 0.4) return "La grilla tiene una densidad demasiado baja.";

  const cellDirections = new Map<string, Set<string>>();
  const entryKeys = new Set<string>();
  const answers = new Set<string>();
  for (const entry of entries) {
    if (!entry.answer || entry.answer.length < 3) return "Hay una entrada demasiado corta.";
    if (answers.has(entry.answer)) return `La respuesta ${entry.answer} esta repetida.`;
    answers.add(entry.answer);
    if (!entry.clue?.trim() || weakClue.test(entry.clue)) {
      return `La pista de ${entry.answer} es vaga o generica.`;
    }
    entryKeys.add(`${entry.direction}:${entry.row}:${entry.col}:${entry.answer}`);
    for (let index = 0; index < entry.answer.length; index++) {
      const row = entry.row + (entry.direction === "down" ? index : 0);
      const col = entry.col + (entry.direction === "across" ? index : 0);
      if (row < 0 || col < 0 || row >= size || col >= size || grid[row][col] === "#") {
        return `La entrada ${entry.answer} no coincide con la grilla.`;
      }
      if (grid[row][col].toUpperCase() !== entry.answer[index].toUpperCase()) {
        return `Las letras de ${entry.answer} no coinciden con la grilla.`;
      }
      const key = `${row}:${col}`;
      const directions = cellDirections.get(key) ?? new Set<string>();
      directions.add(entry.direction);
      cellDirections.set(key, directions);
    }
  }

  for (const entry of entries) {
    let crossings = 0;
    for (let index = 0; index < entry.answer.length; index++) {
      const row = entry.row + (entry.direction === "down" ? index : 0);
      const col = entry.col + (entry.direction === "across" ? index : 0);
      if ((cellDirections.get(`${row}:${col}`)?.size ?? 0) > 1) crossings++;
    }
    if (crossings < 2) return `${entry.answer} tiene menos de dos cruces.`;
  }

  const validateRuns = (direction: "across" | "down") => {
    for (let outer = 0; outer < size; outer++) {
      let inner = 0;
      while (inner < size) {
        const cell = direction === "across" ? grid[outer][inner] : grid[inner][outer];
        if (cell === "#") {
          inner++;
          continue;
        }
        const start = inner;
        let answer = "";
        while (inner < size) {
          const next = direction === "across" ? grid[outer][inner] : grid[inner][outer];
          if (next === "#") break;
          answer += next.toUpperCase();
          inner++;
        }
        if (answer.length < 3) return "La grilla contiene una secuencia de menos de tres letras.";
        const row = direction === "across" ? outer : start;
        const col = direction === "across" ? start : outer;
        if (!entryKeys.has(`${direction}:${row}:${col}:${answer}`)) {
          return `La secuencia ${answer} no corresponde a una entrada jugable.`;
        }
      }
    }
    return null;
  };

  const acrossIssue = validateRuns("across");
  if (acrossIssue) return acrossIssue;
  const downIssue = validateRuns("down");
  if (downIssue) return downIssue;

  return null;
}
