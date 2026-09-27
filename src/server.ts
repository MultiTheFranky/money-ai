import crypto from "crypto";
import express, { Request, Response } from "express";
import path from "path";
import { completeBankAuthorization, getAspsps, getTransactions, startBankAuthorization, AspspRateLimitError } from "./api";
import {
  BankNotLinkedError,
  clearLinkedSession,
  consumePendingState,
  getLinkedSession,
  requireLinkedSession,
  setLinkedSession,
  setPendingState,
} from "./bankSession";
import { config } from "./config";
import { logger } from "./logger";
import { requireAuth } from "./middleware/requireAuth";
import { analyzeTransactionsWithAI } from "./openrouter";
import { parseTransactionsForAI, resolveAccountMeta } from "./parser";
import { indexTransactions, queryRag, summarizeTransactions } from "./rag";
import { createSessionToken, validateCredentials } from "./sessionAuth";
import { getCachedTransactions, getRateLimitCooldownMs, setCachedTransactions, setRateLimited } from "./transactionsCache";
import { SimplifiedTransaction } from "./types";

// Consulta fija usada para recuperar del RAG los movimientos más relevantes para el análisis
const RAG_ANALYSIS_QUERY =
  "gastos elevados, movimientos inusuales o recurrentes y principales categorías de gasto";

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Registra cada petición entrante y su resultado (método, ruta, status, duración)
app.use((req: Request, res: Response, next) => {
  const start = Date.now();
  logger.info("http", `--> ${req.method} ${req.path}`);
  res.on("finish", () => {
    logger.info("http", `<-- ${req.method} ${req.path} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

/** Error ocurrido al recuperar los movimientos de una cuenta concreta */
export interface AccountFetchError {
  accountId: string;
  accountName: string;
  message: string;
}

/** Resultado de recorrer todas las cuentas vinculadas */
export interface CollectedTransactions {
  transactions: SimplifiedTransaction[];
  accountErrors: AccountFetchError[];
}

/**
 * Recorre todas las cuentas vinculadas, devuelve sus movimientos ya simplificados
 * (por defecto, los últimos 6 meses) y los indexa en el RAG local para su uso posterior.
 *
 * Antes de llamar al banco reutiliza la última copia cacheada si es reciente (evita agotar
 * el número de accesos permitidos por el consentimiento PSD2). Si la llamada al banco falla
 * (p. ej. ASPSP_RATE_LIMIT_EXCEEDED) se sirve la última copia cacheada aunque esté desactualizada,
 * en lugar de fallar por completo. La indexación en el RAG es best-effort: si falla (p. ej. el
 * proveedor de embeddings no está disponible) no bloquea la carga de movimientos.
 */
async function collectAllTransactions(): Promise<CollectedTransactions> {
  const session = requireLinkedSession();
  const allTransactions: SimplifiedTransaction[] = [];
  const accountErrors: AccountFetchError[] = [];
  const cacheTtlMs = config.transactionsCacheTtlMinutes * 60 * 1000;

  logger.info("server", `Recolectando movimientos de ${session.accounts.length} cuenta(s) vinculada(s) (${session.aspspName}/${session.aspspCountry})`);

  for (const account of session.accounts) {
    const meta = resolveAccountMeta(account);
    const cached = getCachedTransactions(account.uid);

    if (cached && cached.ageMs < cacheTtlMs) {
      const simplified = parseTransactionsForAI(cached.transactions, meta);
      allTransactions.push(...simplified);
      logger.info(
        "server",
        `Cuenta ${account.uid} (${meta.accountName}): ${simplified.length} movimientos servidos desde caché (edad=${Math.round(cached.ageMs / 1000)}s)`
      );
      continue;
    }

    const cooldownMs = getRateLimitCooldownMs(account.uid);
    if (cooldownMs !== null) {
      const remainingMin = Math.ceil(cooldownMs / 60000);
      logger.warn(
        "server",
        `Cuenta ${account.uid}: en cooldown por rate limit (quedan ~${remainingMin} min), se omite la llamada al banco`
      );
      if (cached) {
        allTransactions.push(...parseTransactionsForAI(cached.transactions, meta));
      }
      accountErrors.push({
        accountId: account.uid,
        accountName: meta.accountName ?? account.uid,
        message: cached
          ? `El banco limitó los accesos a esta cuenta; se muestran datos en caché de ${cached.fetchedAt}. Podrás reintentar en ~${remainingMin} min.`
          : `El banco ha limitado los accesos a esta cuenta. Podrás reintentar en ~${remainingMin} min.`,
      });
      continue;
    }

    try {
      const rawTransactions = await getTransactions(account.uid);
      setCachedTransactions(account.uid, rawTransactions);
      const simplified = parseTransactionsForAI(rawTransactions, meta);
      allTransactions.push(...simplified);
      logger.info("server", `Cuenta ${account.uid} (${meta.accountName}): ${simplified.length} movimientos`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("server", `Falló la cuenta ${account.uid} (${meta.accountName}): ${message}`);

      if (error instanceof AspspRateLimitError) {
        setRateLimited(account.uid, config.rateLimitCooldownMinutes * 60 * 1000);
      }

      if (cached) {
        const simplified = parseTransactionsForAI(cached.transactions, meta);
        allTransactions.push(...simplified);
        logger.warn(
          "server",
          `Cuenta ${account.uid}: se sirve caché desactualizada de ${cached.fetchedAt} tras el fallo`
        );
        accountErrors.push({
          accountId: account.uid,
          accountName: meta.accountName ?? account.uid,
          message: `${message} (mostrando datos en caché de ${cached.fetchedAt})`,
        });
      } else {
        accountErrors.push({ accountId: account.uid, accountName: meta.accountName ?? account.uid, message });
      }
    }
  }

  logger.info("server", `Total recolectado: ${allTransactions.length} movimientos, ${accountErrors.length} cuenta(s) con error`);

  try {
    await indexTransactions(allTransactions);
  } catch (error) {
    logger.warn(
      "server",
      `No se pudo indexar en el RAG (se continúa sin bloquear la carga de movimientos): ${error instanceof Error ? error.message : error}`
    );
  }

  return { transactions: allTransactions, accountErrors };
}

/** Traduce un error a la respuesta HTTP adecuada, distinguiendo la falta de vínculo bancario */
function respondWithError(res: Response, error: unknown): void {
  if (error instanceof BankNotLinkedError) {
    logger.warn("server", `Respondiendo 409 BANK_NOT_LINKED: ${error.message}`);
    res.status(409).json({ error: error.message, code: "BANK_NOT_LINKED" });
    return;
  }
  const message = error instanceof Error ? error.message : "Error desconocido";
  logger.error("server", `Respondiendo 502: ${message}`);
  res.status(502).json({ error: message });
}

app.post("/api/login", (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || typeof password !== "string" || !validateCredentials({ username, password })) {
    res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    return;
  }

  const token = createSessionToken(username);
  res.json({ token });
});

app.get("/api/bank-link/status", requireAuth, (_req: Request, res: Response) => {
  const session = getLinkedSession();
  logger.info("server", `Estado de vinculación consultado: ${session ? `vinculado a ${session.aspspName}/${session.aspspCountry}` : "sin vincular"}`);
  res.json({
    linked: session !== null,
    aspsp: session ? { name: session.aspspName, country: session.aspspCountry } : null,
  });
});

app.get("/api/aspsps", requireAuth, async (req: Request, res: Response) => {
  try {
    const country = typeof req.query.country === "string" ? req.query.country : undefined;
    const aspsps = await getAspsps(country);
    res.json({ aspsps });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.post("/api/bank-link/start", requireAuth, async (req: Request, res: Response) => {
  const { aspspName, aspspCountry } = req.body ?? {};

  if (typeof aspspName !== "string" || typeof aspspCountry !== "string") {
    logger.warn("server", "POST /api/bank-link/start: faltan aspspName/aspspCountry en el body");
    res.status(400).json({ error: "Debes indicar aspspName y aspspCountry" });
    return;
  }

  try {
    const state = crypto.randomUUID();
    setPendingState(state);
    logger.info("server", `Iniciando vinculación con ${aspspName}/${aspspCountry} (state=${state})`);
    const authorization = await startBankAuthorization(aspspName, aspspCountry, state);
    res.json({ url: authorization.url });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.post("/api/bank-link/unlink", requireAuth, (_req: Request, res: Response) => {
  logger.info("server", "Desvinculando cuenta bancaria a petición del usuario");
  clearLinkedSession();
  res.json({ message: "OK" });
});

// El banco redirige aquí el navegador del usuario tras la autorización (sin nuestro JWT de sesión)
// La ruta debe coincidir con la redirect_url registrada en Enable Banking (ver config.enableBankingRedirectUrl)
app.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  logger.info("server", `Callback de Enable Banking recibido (state=${state ?? "-"}, error=${error ?? "ninguno"})`);

  if (typeof error === "string") {
    logger.warn("server", `Autorización rechazada por el banco: ${errorDescription ?? error}`);
    res.redirect(`/?linkError=${encodeURIComponent(String(errorDescription ?? error))}`);
    return;
  }

  if (typeof code !== "string" || typeof state !== "string" || !consumePendingState(state)) {
    logger.warn("server", "Callback con code/state inválido o state ya consumido/expirado");
    res.redirect(`/?linkError=${encodeURIComponent("Autorización inválida o expirada")}`);
    return;
  }

  try {
    const authorized = await completeBankAuthorization(code);
    setLinkedSession({
      sessionId: authorized.session_id,
      accounts: authorized.accounts,
      aspspName: authorized.aspsp.name,
      aspspCountry: authorized.aspsp.country,
      linkedAt: new Date().toISOString(),
    });
    logger.info("server", `Vinculación completada: ${authorized.aspsp.name}/${authorized.aspsp.country}, ${authorized.accounts.length} cuentas`);
    res.redirect("/?linked=1");
  } catch (err) {
    logger.error("server", `Fallo completando la vinculación: ${err instanceof Error ? err.message : err}`);
    res.redirect(`/?linkError=${encodeURIComponent(err instanceof Error ? err.message : "Error desconocido")}`);
  }
});

app.get("/api/transactions", requireAuth, async (_req: Request, res: Response) => {
  try {
    const { transactions, accountErrors } = await collectAllTransactions();
    res.json({ transactions, ragIndexed: transactions.length, accountErrors });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.post("/api/analyze", requireAuth, async (_req: Request, res: Response) => {
  try {
    logger.info("server", "Iniciando análisis con IA...");
    const { transactions } = await collectAllTransactions();
    const summary = summarizeTransactions(transactions);
    logger.debug("server", `Resumen agregado generado para el prompt:\n${summary}`);
    const relevant = await queryRag(RAG_ANALYSIS_QUERY, config.ragTopK);
    const sample = relevant.length > 0 ? relevant.map((entry) => entry.transaction) : transactions;
    logger.info("server", `Analizando ${sample.length} movimientos (${relevant.length > 0 ? "muestra del RAG" : "todos, sin índice RAG"})`);
    const analysis = await analyzeTransactionsWithAI(sample, summary);
    logger.info("server", "Análisis con IA completado");
    res.json({ analysis });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.listen(config.port, () => {
  logger.info("server", `Servidor de Money AI escuchando en http://localhost:${config.port}`);
});
