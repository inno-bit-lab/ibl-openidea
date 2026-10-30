/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
const port = Number(process.env.OPENIDEA_DEV_PORT ?? 1420);

export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // `invoke` with remote-development routing (src/platform/tauriCore.ts).
      { find: /^@tauri-apps\/api\/core$/, replacement: fileURLToPath(new URL("./src/platform/tauriCore.ts", import.meta.url)) },
    ],
  },
  // Tauri: keep Rust errors visible, require the selected port, don't watch the backend.
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: port + 1 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: {
    target: "safari16",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "perf/**/*.test.ts", "scripts/**/*.test.ts"],
  },
}));
