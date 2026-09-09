import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// The admin UI is mounted at /admin/ by the Worker. In dev, API and DAV calls are
// proxied to the wrangler dev server (see `npm run dev`).
export default defineConfig({
  root,
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": `${root}src` },
  },
  build: {
    outDir: `${root}dist`,
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 47322,
    proxy: {
      "/api": "http://127.0.0.1:47321",
    },
  },
});
