import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import cascadeLayers from "@csstools/postcss-cascade-layers";
import postcssPresetEnv from "postcss-preset-env";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom/test-utils": "preact/test-utils",
      "react-dom/client": "preact/compat/client",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
      "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
    },
  },
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
    minify: "esbuild",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
