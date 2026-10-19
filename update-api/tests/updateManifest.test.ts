import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUpdateManifest } from "../src/logic/updateManifest";
import type { Env } from "../src/env";

const env: Env = {
  GITHUB_OWNER: "dueno",
  GITHUB_REPO: "clio-repo",
  GITHUB_REPO_ADMINISTRATIVO: "admin-repo",
  GITHUB_TOKEN: "pat",
  INSTALLATIONS_TURSO_URL: "",
  INSTALLATIONS_TURSO_TOKEN: "",
  MAIN_TURSO_URL: "",
  MAIN_TURSO_TOKEN_RO: "",
  DOWNLOAD_TOKEN_SECRET: "secreto",
};

function mockGithub(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      calls.push(input);
      if (input.endsWith("/releases/latest")) {
        return Response.json({
          tag_name: "app-v0.2.0",
          assets: [
            { id: 1, name: "latest.json" },
            { id: 2, name: "App.app.tar.gz" },
          ],
        });
      }
      return new Response(
        JSON.stringify({
          version: "0.2.0",
          notes: "",
          pub_date: "2026-01-01T00:00:00Z",
          platforms: { "darwin-aarch64": { signature: "sig", url: "https://github.com/x/y/releases/download/app-v0.2.0/App.app.tar.gz" } },
        }),
      );
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("buildUpdateManifest", () => {
  it("Administrativo lee su propio repo y reescribe las URLs a su ruta de descarga", async () => {
    const calls = mockGithub();
    const manifest = await buildUpdateManifest(env, "https://worker.test", "administrativo");
    expect(calls.every((c) => c.includes("/repos/dueno/admin-repo/"))).toBe(true);
    expect(manifest?.platforms["darwin-aarch64"].url).toMatch(/^https:\/\/worker\.test\/updates\/administrativo\/download\/2\?token=/);
  });

  it("devuelve null si el repo todavía no tiene releases (404)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(buildUpdateManifest(env, "https://worker.test", "administrativo")).resolves.toBeNull();
  });

  it("Clio sigue leyendo su repo y su ruta de descarga de siempre", async () => {
    const calls = mockGithub();
    const manifest = await buildUpdateManifest(env, "https://worker.test");
    expect(calls.every((c) => c.includes("/repos/dueno/clio-repo/"))).toBe(true);
    expect(manifest?.platforms["darwin-aarch64"].url).toMatch(/^https:\/\/worker\.test\/updates\/download\/2\?token=/);
  });
});
