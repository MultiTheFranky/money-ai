import crypto from "crypto";
import express, { Request, Response } from "express";
import path from "path";
import { completeBankAuthorization, getAspsps, getTransactions, startBankAuthorization } from "./api";
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
import { requireAuth } from "./middleware/requireAuth";
import { analyzeTransactionsWithAI } from "./openrouter";
import { parseTransactionsForAI } from "./parser";
import { indexTransactions, queryRag, summarizeTransactions } from "./rag";
import { createSessionToken, validateCredentials } from "./sessionAuth";
import { SimplifiedTransaction } from "./types";

// Consulta fija usada para recuperar del RAG los movimientos más relevantes para el análisis
const RAG_ANALYSIS_QUERY =
  "gastos elevados, movimientos inusuales o recurrentes y principales categorías de gasto";

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/**
 * Recorre todas las cuentas vinculadas, devuelve sus movimientos ya simplificados
 * (por defecto, los últimos 6 meses) y los indexa en el RAG local para su uso posterior.
 */
async function collectAllTransactions(): Promise<SimplifiedTransaction[]> {
  const session = requireLinkedSession();
  const allTransactions: SimplifiedTransaction[] = [];

  for (const account of session.accounts) {
    const rawTransactions = await getTransactions(account.uid);
    allTransactions.push(...parseTransactionsForAI(rawTransactions));
  }

  await indexTransactions(allTransactions);
  return allTransactions;
}

/** Traduce un error a la respuesta HTTP adecuada, distinguiendo la falta de vínculo bancario */
function respondWithError(res: Response, error: unknown): void {
  if (error instanceof BankNotLinkedError) {
    res.status(409).json({ error: error.message, code: "BANK_NOT_LINKED" });
    return;
  }
  res.status(502).json({ error: error instanceof Error ? error.message : "Error desconocido" });
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
    res.status(400).json({ error: "Debes indicar aspspName y aspspCountry" });
    return;
  }

  try {
    const state = crypto.randomUUID();
    setPendingState(state);
    const authorization = await startBankAuthorization(aspspName, aspspCountry, state);
    res.json({ url: authorization.url });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.post("/api/bank-link/unlink", requireAuth, (_req: Request, res: Response) => {
  clearLinkedSession();
  res.json({ message: "OK" });
});

// El banco redirige aquí el navegador del usuario tras la autorización (sin nuestro JWT de sesión)
// La ruta debe coincidir con la redirect_url registrada en Enable Banking (ver config.enableBankingRedirectUrl)
app.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (typeof error === "string") {
    res.redirect(`/?linkError=${encodeURIComponent(String(errorDescription ?? error))}`);
    return;
  }

  if (typeof code !== "string" || typeof state !== "string" || !consumePendingState(state)) {
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
    res.redirect("/?linked=1");
  } catch (err) {
    res.redirect(`/?linkError=${encodeURIComponent(err instanceof Error ? err.message : "Error desconocido")}`);
  }
});

app.get("/api/transactions", requireAuth, async (_req: Request, res: Response) => {
  try {
    const transactions = await collectAllTransactions();
    res.json({ transactions, ragIndexed: transactions.length });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.post("/api/analyze", requireAuth, async (_req: Request, res: Response) => {
  try {
    const transactions = await collectAllTransactions();
    const summary = summarizeTransactions(transactions);
    const relevant = await queryRag(RAG_ANALYSIS_QUERY, config.ragTopK);
    const sample = relevant.length > 0 ? relevant.map((entry) => entry.transaction) : transactions;
    const analysis = await analyzeTransactionsWithAI(sample, summary);
    res.json({ analysis });
  } catch (error) {
    respondWithError(res, error);
  }
});

app.listen(config.port, () => {
  console.log(`Servidor de Money AI escuchando en http://localhost:${config.port}`);
});
