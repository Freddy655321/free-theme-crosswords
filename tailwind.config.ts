import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx,js,jsx,mdx}", "./components/**/*.{ts,tsx,js,jsx,mdx}"],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
