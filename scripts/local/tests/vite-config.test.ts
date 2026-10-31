// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile } from "vite";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("../../../vite.config.ts", import.meta.url));

async function readDevServer() {
  const result = await loadConfigFromFile({ command: "serve", mode: "development" }, configPath);
  if (!result) throw new Error("Vite configuration did not load");
  return result.config.server;
}

afterEach(() => vi.unstubAllEnvs());

describe("local development ports", () => {
  it("preserves the upstream default without a worktree override", async () => {
    vi.stubEnv("OPENIDEA_DEV_PORT", undefined);
    vi.stubEnv("TAURI_DEV_HOST", "");
    const server = await readDevServer();
    expect(server?.port).toBe(1420);
    expect(server?.hmr).toBeUndefined();
  });

  it("uses the reserved adjacent HMR port for a local worktree", async () => {
    vi.stubEnv("OPENIDEA_DEV_PORT", "1778");
    vi.stubEnv("TAURI_DEV_HOST", "");
    const server = await readDevServer();
    expect(server?.port).toBe(1778);
    expect(server?.hmr).toEqual({ protocol: "ws", host: "localhost", port: 1779 });
  });

  it("uses the selected host with its adjacent HMR port", async () => {
    vi.stubEnv("OPENIDEA_DEV_PORT", "1778");
    vi.stubEnv("TAURI_DEV_HOST", "127.0.0.1");
    const server = await readDevServer();
    expect(server?.port).toBe(1778);
    expect(server?.hmr).toEqual({ protocol: "ws", host: "127.0.0.1", port: 1779 });
  });
});
