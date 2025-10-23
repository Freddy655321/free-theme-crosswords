// app/page.tsx
import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Crosswords</h1>
      <p>Proyecto conectado correctamente.</p>
      <ul>
        <li><Link href="/generar">Generar puzzle (IA)</Link></li>
        <li><Link href="/jugar/pro">Jugar ahora (Pro)</Link></li>
      </ul>
    </main>
  );
}
