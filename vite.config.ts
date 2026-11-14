import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import cascadeLayers from "@csstools/postcss-cascade-layers";
import postcssPresetEnv from "postcss-preset-env";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss(),
        cascadeLayers(),
        postcssPresetEnv({
          browsers: "chrome >= 70",
          stage: 2,
          features: {
            "cascade-layers": false,
          },
        }),
      ],
    },
  },
  build: {
    target: "chrome70",
    cssTarget: "chrome70",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
