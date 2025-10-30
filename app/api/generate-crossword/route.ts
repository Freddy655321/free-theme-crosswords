// app/api/generate-crossword/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Language = "es" | "en";

type Body = {
  theme?: string;
  language?: Language;
};

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      where: "/api/generate-crossword",
      hint: "Use POST with { theme, language }",
    },
    { status: 200 }
  );
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const theme = (body.theme ?? "").trim();
  const language = body.language;

  if (!theme) {
    return NextResponse.json({ error: "Field 'theme' is required" }, { status: 400 });
  }

  if (language !== "es" && language !== "en") {
    return NextResponse.json(
      { error: "Field 'language' must be 'es' or 'en'" },
      { status: 400 }
    );
  }

  // Demo payload para destrabar el 405. Luego enchufamos la generación real.
  const demoPayload = {
    title: `${theme} — demo`,
    language,
    grid: [],
    clues: { across: [], down: [] },
    meta: { source: "demo" },
  };

  return NextResponse.json(demoPayload, { status: 200 });
}
