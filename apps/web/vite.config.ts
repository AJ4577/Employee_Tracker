import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE lets the same build run at a sub-path (e.g. GitHub Pages: /Employee_Tracker/).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { sourcemap: false, target: "es2020", chunkSizeWarningLimit: 900 },
});
