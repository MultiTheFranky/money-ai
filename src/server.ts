import crypto from "crypto";
import express, { Request, Response } from "express";
import path from "path";
import { completeBankAuthorization, getAspsps, startBankAuthorization } from "./api";
import {
  BankNotLinkedError,
  clearLinkedSession,
  consumePendingState,
  getLinkedSession,
  setLinkedSession,
  setPendingState,
} from "./bankSession";
import { collectAllTransactions, CollectedTransactions } from "./collector";
import { config } from "./config";
import { logger } from "./logger";
import { requireAuth } from "./middleware/requireAuth";
import { analyzeTransactionsWithAI } from "./openrouter";
import { indexTransactions, queryRag, summarizeTransactions } from "./rag";
import { createSessionToken, validateCredentials } from "./sessionAuth";

// Consulta fija usada para recuperar del RAG los movimientos más relevantes para el análisis
const RAG_ANALYSIS_QUERY =
  "gastos elevados, movimientos inusuales o recurrentes y principales categorías de gasto";

const app = express();

// La app corre tras un proxy inverso; necesario para que req.ip sea la IP real del usuario
app.set("trust proxy", 1);

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

/**
 * Cabeceras Psu-* que indican al banco que el usuario está presente. Sin ellas, PSD2 trata la
 * consulta como acceso en segundo plano, limitado a ~4 al día por consentimiento.
 */
function buildPsuHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const ip = req.ip?.replace(/^::ffff:/, "");
  if (ip) {
    headers["Psu-Ip-Address"] = ip;
  }
  const forwarded: [string, string][] = [
    ["user-agent", "Psu-User-Agent"],
    ["referer", "Psu-Referer"],
    ["accept", "Psu-Accept"],
    ["accept-encoding", "Psu-Accept-Encoding"],
    ["accept-language", "Psu-Accept-Language"],
  ];
  for (const [source, target] of forwarded) {
    const value = req.get(source);
    if (value) {
      headers[target] = value;
    }
  }
  return headers;
}

/** Recolecta los movimientos y los indexa en el RAG; si la indexación falla, no bloquea la carga */
async function collectAndIndex(psuHeaders: Record<string, string>): Promise<CollectedTransactions> {
  const collected = await collectAllTransactions(psuHeaders);
  try {
    await indexTransactions(collected.transactions);
  } catch (error) {
    logger.warn(
      "server",
      `No se pudo indexar en el RAG (se continúa sin bloquear la carga de movimientos): ${error instanceof Error ? error.message : error}`
    );
  }
  return collected;
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

app.get("/api/transactions", requireAuth, async (req: Request, res: Response) => {
  try {
    const { transactions, accountErrors } = await collectAndIndex(buildPsuHeaders(req));
    res.json({ transactions, ragIndexed: transactions.length, accountErrors });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.post("/api/analyze", requireAuth, async (req: Request, res: Response) => {
  try {
    logger.info("server", "Iniciando análisis con IA...");
    const { transactions } = await collectAndIndex(buildPsuHeaders(req));
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
