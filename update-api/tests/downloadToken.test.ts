import { describe, expect, it, vi } from "vitest";
import { issueDownloadToken, verifyDownloadToken } from "../src/logic/downloadToken";

const SECRET = "test-secret";

describe("issueDownloadToken / verifyDownloadToken", () => {
  it("un token recién emitido verifica contra el mismo assetId", async () => {
    const token = await issueDownloadToken(42, SECRET);
    await expect(verifyDownloadToken(42, token, SECRET)).resolves.toBe(true);
  });

  it("rechaza si el assetId no coincide (token emitido para otro asset)", async () => {
    const token = await issueDownloadToken(42, SECRET);
    await expect(verifyDownloadToken(43, token, SECRET)).resolves.toBe(false);
  });

  it("rechaza con el secreto equivocado", async () => {
    const token = await issueDownloadToken(42, SECRET);
    await expect(verifyDownloadToken(42, token, "otro-secreto")).resolves.toBe(false);
  });

  it("rechaza un token mal formado", async () => {
    await expect(verifyDownloadToken(42, "no-es-un-token-valido", SECRET)).resolves.toBe(false);
  });

  it("rechaza un token vencido", async () => {
    vi.useFakeTimers();
    try {
      const token = await issueDownloadToken(42, SECRET);
      vi.advanceTimersByTime(11 * 60_000); // TTL es 10 minutos
      await expect(verifyDownloadToken(42, token, SECRET)).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
