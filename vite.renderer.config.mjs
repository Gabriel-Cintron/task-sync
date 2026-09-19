import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/desktop/renderer",
  build: {
    outDir: resolve(process.cwd(), ".vite", "renderer", "main_window"),
    sourcemap: true,
  },
});
