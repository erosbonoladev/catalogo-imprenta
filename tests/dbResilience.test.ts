import type { Client, Transaction } from "@libsql/client/web";
import { describe, expect, it, vi } from "vitest";
import { isNetworkError, MENSAJE_SIN_CONEXION, withNetworkResilience } from "../src/dbResilience";

const loadFailed = () => new TypeError("Load failed");

function fakeClient(execute: (stmt: unknown) => Promise<unknown>, extra: Partial<Client> = {}): Client {
  return { execute, batch: vi.fn(), transaction: vi.fn(), ...extra } as unknown as Client;
}

describe("isNetworkError", () => {
  it("reconoce los TypeError de fetch de WebKit, WebView2 y Node", () => {
    expect(isNetworkError(new TypeError("Load failed"))).toBe(true);
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
  });

  it("no confunde errores de programación ni errores de SQL con cortes de red", () => {
    expect(isNetworkError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isNetworkError(new Error("Load failed"))).toBe(false);
    expect(isNetworkError(new Error("SQLITE_CONSTRAINT: UNIQUE"))).toBe(false);
  });
});

describe("withNetworkResilience — execute", () => {
  it("reintenta un SELECT tras un corte de red y devuelve el resultado", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(loadFailed())
      .mockRejectedValueOnce(loadFailed())
      .mockResolvedValueOnce({ rows: [1] });
    const client = withNetworkResilience(fakeClient(execute));

    await expect(client.execute("SELECT * FROM remisiones")).resolves.toEqual({ rows: [1] });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("agotados los reintentos, lanza el mensaje claro (con la causa original)", async () => {
    const execute = vi.fn().mockRejectedValue(loadFailed());
    const client = withNetworkResilience(fakeClient(execute));

    const err = await client.execute({ sql: "SELECT 1", args: [] }).catch((e) => e);
    expect(err.message).toBe(MENSAJE_SIN_CONEXION);
    expect((err as { cause: unknown }).cause).toBeInstanceOf(TypeError);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("NUNCA reintenta una escritura (podría haber llegado al servidor y duplicarse), pero sí traduce el error", async () => {
    const execute = vi.fn().mockRejectedValue(loadFailed());
    const client = withNetworkResilience(fakeClient(execute));

    await expect(client.execute({ sql: "INSERT INTO folios (seccion) VALUES (?1)", args: ["remision"] })).rejects.toThrow(
      MENSAJE_SIN_CONEXION,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("errores que no son de red pasan intactos y sin reintento", async () => {
    const original = new Error("SQLITE_CONSTRAINT: UNIQUE");
    const execute = vi.fn().mockRejectedValue(original);
    const client = withNetworkResilience(fakeClient(execute));

    await expect(client.execute("SELECT 1")).rejects.toBe(original);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("withNetworkResilience — batch y transacciones", () => {
  it("batch traduce el corte de red sin reintentar", async () => {
    const batch = vi.fn().mockRejectedValue(loadFailed());
    const client = withNetworkResilience(fakeClient(vi.fn(), { batch } as Partial<Client>));

    await expect(client.batch(["UPDATE x SET y = 1"], "write")).rejects.toThrow(MENSAJE_SIN_CONEXION);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("un rollback que falla no tapa el error real del catch", async () => {
    const tx = {
      execute: vi.fn().mockRejectedValue(loadFailed()),
      batch: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn().mockRejectedValue(new Error("cannot rollback - no transaction is active")),
    } as unknown as Transaction;
    const client = withNetworkResilience(
      fakeClient(vi.fn(), { transaction: vi.fn().mockResolvedValue(tx) } as Partial<Client>),
    );

    const wrapped = await client.transaction("write");
    let thrown: unknown;
    try {
      await wrapped.execute("UPDATE x SET y = 1");
    } catch (err) {
      thrown = err;
      await wrapped.rollback();
    }
    expect((thrown as Error).message).toBe(MENSAJE_SIN_CONEXION);
  });
});
