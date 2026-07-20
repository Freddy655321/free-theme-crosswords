// lib/supabaseAdmin.ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// IMPORTANT:
// - Use SERVICE ROLE key ONLY on the server (never in client components).
// - "server-only" ensures Next.js throws if imported from client code.
export const supabaseAdmin = createClient(
  requiredEnv("SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);
