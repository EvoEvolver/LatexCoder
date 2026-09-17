import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(root, "src/client") } },
  // CodeMirror, Yjs, and PDF.js live in a lazy editor chunk; the dashboard
  // remains small and loads independently.
  build: { chunkSizeWarningLimit: 1_100 },
  server: {
    proxy: {
      "/git": "http://127.0.0.1:8090",
      "/health": "http://127.0.0.1:8090",
      "/share": "http://127.0.0.1:8090",
      "/v1": { target: "http://127.0.0.1:8090", ws: true },
    },
  },
});
