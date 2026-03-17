import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        shell: "#f4efe5",
        ink: "#132226",
        mint: "#93c6b4",
        teal: "#2f6d73",
        coral: "#e07a5f",
        sand: "#d7c8b6",
        fog: "#eef3f2"
      },
      boxShadow: {
        card: "0 24px 64px rgba(19, 34, 38, 0.12)"
      },
      backgroundImage: {
        "hero-mesh":
          "radial-gradient(circle at top left, rgba(147, 198, 180, 0.5), transparent 34%), radial-gradient(circle at top right, rgba(224, 122, 95, 0.18), transparent 26%), linear-gradient(135deg, rgba(255,255,255,0.95), rgba(244,239,229,0.85))"
      }
    }
  },
  plugins: []
};

export default config;
