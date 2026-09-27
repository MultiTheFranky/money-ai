import express, { Request, Response } from "express";
import path from "path";
import { getAccounts, getTransactions } from "./api";
import { config } from "./config";
import { requireAuth } from "./middleware/requireAuth";
import { analyzeTransactionsWithAI } from "./openrouter";
import { parseTransactionsForAI } from "./parser";
import { createSessionToken, validateCredentials } from "./sessionAuth";
import { SimplifiedTransaction } from "./types";

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/** Recorre todas las cuentas del usuario y devuelve sus movimientos ya simplificados */
async function collectAllTransactions(): Promise<SimplifiedTransaction[]> {
  const accountIds = await getAccounts();
  const allTransactions: SimplifiedTransaction[] = [];

  for (const accountId of accountIds) {
    const rawTransactions = await getTransactions(accountId);
    allTransactions.push(...parseTransactionsForAI(rawTransactions));
  }

  return allTransactions;
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

app.get("/api/transactions", requireAuth, async (_req: Request, res: Response) => {
  try {
    const transactions = await collectAllTransactions();
    res.json({ transactions });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Error desconocido" });
  }
});

app.post("/api/analyze", requireAuth, async (_req: Request, res: Response) => {
  try {
    const transactions = await collectAllTransactions();
    const analysis = await analyzeTransactionsWithAI(transactions);
    res.json({ analysis });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Error desconocido" });
  }
});

app.listen(config.port, () => {
  console.log(`Servidor de Money AI escuchando en http://localhost:${config.port}`);
});
