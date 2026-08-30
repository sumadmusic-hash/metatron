import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5175,
  },
  build: {
    rollupOptions: {
      // Multi-page build so the POC page is also emitted by `vite build`
      // without touching the productive index.html entry ("main").
      input: {
        main: resolve("index.html"),
        "poc/chain-discovery": resolve("poc/chain-discovery/index.html"),
        "poc/chain-clone": resolve("poc/chain-clone/index.html"),
        "poc/chain-clone-live": resolve("poc/chain-clone-live/index.html"),
        "poc/instrument-preset-live": resolve("poc/instrument-preset-live/index.html"),
      },
    },
  },
})