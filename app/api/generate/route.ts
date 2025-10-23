// app/api/generate/route.ts
import { NextResponse } from "next/server";
import type { Puzzle, GenerateRequest, Cell, Clue } from "../../../types/puzzle";

function buildDemoPuzzle(topic: string): Puzzle {
  const width = 5;
  const height = 5;
  const template = [
    "APPLE",
    "#P#I#",
    "TASTE",
    "#E#A#",
    "JUICE",
  ];

  const grid: Cell[] = [];
  let number = 0;

  const get = (r: number, c: number) => template[r]?.[c] ?? "#";

  const isStart = (r: number, c: number, dir: "across" | "down") => {
    if (get(r, c) === "#") return false;
    if (dir === "across") return c === 0 || get(r, c - 1) === "#";
    return r === 0 || get(r - 1, c) === "#";
  };

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const ch = get(r, c);
      const isBlock = ch === "#";
      let num: number | undefined = undefined;
      if (!isBlock && (isStart(r, c, "across") || isStart(r, c, "down"))) {
        number += 1;
        num = number;
      }
      grid.push({ row: r, col: c, char: isBlock ? "" : "", isBlock, number: num });
    }
  }

  const clues: Clue[] = [];
  number = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (get(r, c) === "#") continue;
      const startsAcross = isStart(r, c, "across");
      const startsDown = isStart(r, c, "down");
      if (startsAcross || startsDown) number += 1;

      if (startsAcross) {
        let ans = "";
        let cc = c;
        while (cc < width && get(r, cc) !== "#") {
          ans += get(r, cc);
          cc++;
        }
        clues.push({ number, direction: "across", answer: ans, text: `Pista horizontal para ${ans}` });
      }
      if (startsDown) {
        let ans = "";
        let rr = r;
        while (rr < height && get(rr, c) !== "#") {
          ans += get(rr, c);
          rr++;
        }
        clues.push({ number, direction: "down", answer: ans, text: `Pista vertical para ${ans}` });
      }
    }
  }

  return {
    id: "demo-5x5",
    title: `Mini: ${topic || "Demo"}`,
    width,
    height,
    grid,
    clues,
  };
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<GenerateRequest>;
  const topic = (body.topic || "Demo").slice(0, 50);
  const puzzle = buildDemoPuzzle(topic);
  return NextResponse.json({ puzzle });
}
