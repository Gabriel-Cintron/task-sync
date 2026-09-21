import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: false,
    minify: false,
    rollupOptions: {
      external: ["electron"],
    },
  },
});
