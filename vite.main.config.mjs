import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
    minify: false,
    lib: {
      entry: "src/desktop/main.ts",
      formats: ["cjs"],
      fileName: "main",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
});
