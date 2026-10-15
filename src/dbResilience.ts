import type { Client, InStatement, Transaction, TransactionMode } from "@libsql/client/web";

export const MENSAJE_SIN_CONEXION =
  "Se perdió la conexión con el servidor. Revisa tu internet e intenta de nuevo; si estabas guardando, verifica que los cambios se hayan aplicado antes de repetir.";

const NETWORK_ERROR_PATTERN = /load failed|failed to fetch|networkerror|fetch failed|network request failed/i;

// fetch() rechaza con un TypeError cuando la petición no llega o se corta —
// el texto cambia por motor: "Load failed" (WebKit/macOS), "Failed to fetch"
// (WebView2/Windows), "fetch failed" (Node).
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError && NETWORK_ERROR_PATTERN.test(err.message);
}

function toFriendlyError(err: unknown): unknown {
  return isNetworkError(err) ? Object.assign(new Error(MENSAJE_SIN_CONEXION), { cause: err }) : err;
}

// Solo SELECT se reintenta: una escritura cuya respuesta se perdió pudo haber
// llegado al servidor, y repetirla duplicaría la fila (p.ej. un folio).
function isReadOnly(stmt: InStatement): boolean {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  return /^\s*select\b/i.test(sql);
}

const RETRY_DELAYS_MS = [400, 1200];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFriendlyErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toFriendlyError(err);
  }
}

function wrapTransaction(tx: Transaction): Transaction {
  const execute = tx.execute.bind(tx);
  const batch = tx.batch.bind(tx);
  const commit = tx.commit.bind(tx);
  const rollback = tx.rollback.bind(tx);
  tx.execute = ((stmt: InStatement) => withFriendlyErrors(() => execute(stmt))) as Transaction["execute"];
  tx.batch = ((stmts: InStatement[]) => withFriendlyErrors(() => batch(stmts))) as Transaction["batch"];
  tx.commit = () => withFriendlyErrors(commit);
  // Todos los `catch (err) { await tx.rollback(); throw err; }` del código
  // pierden el error real si rollback() también lanza: cuando la causa fue un
  // corte de red o un stream idle, el servidor ya descartó la transacción y
  // el rollback responde "cannot rollback - no transaction is active",
  // tapando el motivo verdadero. Descartar la transacción ya es lo que
  // quedó hecho, así que un rollback fallido no aporta nada que reportar.
  tx.rollback = async () => {
    try {
      await rollback();
    } catch {
      // ver arriba
    }
  };
  return tx;
}

// Envuelve el cliente de libsql in situ: reintenta lecturas sueltas ante un
// corte de red y traduce el TypeError crudo del webview ("Load failed") a un
// mensaje que el usuario entiende, para todas las llamadas de db.ts.
export function withNetworkResilience(client: Client): Client {
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  const transaction = client.transaction.bind(client);

  client.execute = (async (stmt: InStatement) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await execute(stmt);
      } catch (err) {
        if (isNetworkError(err) && isReadOnly(stmt) && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw toFriendlyError(err);
      }
    }
  }) as Client["execute"];

  client.batch = ((stmts: InStatement[], mode?: TransactionMode) =>
    withFriendlyErrors(() => batch(stmts, mode))) as Client["batch"];

  client.transaction = (async (mode: TransactionMode = "deferred") =>
    wrapTransaction(await withFriendlyErrors(() => transaction(mode)))) as Client["transaction"];

  return client;
}
