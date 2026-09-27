import axios from "axios";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { SimplifiedTransaction } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
const INDEX_FILE = path.join(DATA_DIR, "rag-index.json");
// OpenRouter admite varios inputs por petición; se agrupan para reducir latencia y llamadas
const EMBEDDING_BATCH_SIZE = 64;

/** Entrada del índice RAG: texto legible + su embedding + el movimiento original */
export interface RagEntry {
  text: string;
  embedding: number[];
  transaction: SimplifiedTransaction;
}

/** Representación textual de un movimiento, lista para generar su embedding */
function buildTransactionText(tx: SimplifiedTransaction): string {
  const kind = tx.amount >= 0 ? "ingreso" : "gasto";
  const account = tx.accountName ? ` | cuenta: ${tx.accountName}${tx.accountType === "CARD" ? " (tarjeta)" : ""}` : "";
  return `${tx.date} | ${kind} de ${Math.abs(tx.amount).toFixed(2)} ${tx.currency} | ${tx.concept}${account}`;
}

/** Genera embeddings para una lista de textos llamando a POST /embeddings de OpenRouter */
async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!config.openRouterApiKey) {
    throw new Error("Falta configurar la variable de entorno OPENROUTER_API_KEY");
  }
  if (texts.length === 0) {
    return [];
  }

  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);

    try {
      const response = await axios.post(
        config.openRouterEmbeddingsUrl,
        { model: config.openRouterEmbeddingModel, input: batch },
        {
          headers: {
            Authorization: `Bearer ${config.openRouterApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": config.appUrl,
            "X-Title": config.appName,
          },
        }
      );

      for (const item of response.data.data as { embedding: number[] }[]) {
        embeddings.push(item.embedding);
      }
    } catch (error) {
      throw new Error(`Error generando embeddings en OpenRouter: ${describeError(error)}`);
    }
  }

  return embeddings;
}

/**
 * Genera embeddings para los movimientos y los persiste en el índice RAG local
 * (sobrescribiendo el índice anterior), listos para búsquedas semánticas.
 */
export async function indexTransactions(transactions: SimplifiedTransaction[]): Promise<number> {
  const texts = transactions.map(buildTransactionText);
  const embeddings = await embedTexts(texts);

  const entries: RagEntry[] = transactions.map((transaction, i) => ({
    text: texts[i],
    embedding: embeddings[i],
    transaction,
  }));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(entries), "utf8");
  return entries.length;
}

/** Lee el índice RAG persistido (vacío si todavía no se ha generado ninguno) */
export function getRagIndex(): RagEntry[] {
  if (!fs.existsSync(INDEX_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")) as RagEntry[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Devuelve los `topK` movimientos del índice RAG más relevantes semánticamente para `query` */
export async function queryRag(query: string, topK: number): Promise<RagEntry[]> {
  const index = getRagIndex();
  if (index.length === 0) {
    return [];
  }

  const [queryEmbedding] = await embedTexts([query]);

  return index
    .map((entry) => ({ entry, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((result) => result.entry);
}

/** Resumen agregado (ingresos/gastos por divisa) usado como contexto adicional para la IA */
export function summarizeTransactions(transactions: SimplifiedTransaction[]): string {
  if (transactions.length === 0) {
    return "No hay movimientos en el periodo analizado.";
  }

  const byCurrency = new Map<string, { income: number; expense: number }>();
  for (const tx of transactions) {
    const bucket = byCurrency.get(tx.currency) ?? { income: 0, expense: 0 };
    if (tx.amount >= 0) {
      bucket.income += tx.amount;
    } else {
      bucket.expense += Math.abs(tx.amount);
    }
    byCurrency.set(tx.currency, bucket);
  }

  const dates = transactions.map((tx) => tx.date).sort();
  const lines = [
    `Periodo analizado: ${dates[0]} a ${dates[dates.length - 1]} (${transactions.length} movimientos).`,
  ];

  for (const [currency, { income, expense }] of byCurrency) {
    lines.push(
      `- ${currency}: ingresos ${income.toFixed(2)}, gastos ${expense.toFixed(2)}, neto ${(income - expense).toFixed(2)}.`
    );
  }

  const cardTransactions = transactions.filter((tx) => tx.accountType === "CARD");
  if (cardTransactions.length > 0) {
    const cardExpenseByCurrency = new Map<string, number>();
    for (const tx of cardTransactions) {
      if (tx.amount < 0) {
        cardExpenseByCurrency.set(
          tx.currency,
          (cardExpenseByCurrency.get(tx.currency) ?? 0) + Math.abs(tx.amount)
        );
      }
    }
    lines.push(`Gasto con tarjeta (${cardTransactions.length} movimientos):`);
    for (const [currency, expense] of cardExpenseByCurrency) {
      lines.push(`- ${currency}: ${expense.toFixed(2)} gastados con tarjeta.`);
    }
  }

  return lines.join("\n");
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = JSON.stringify(error.response?.data);
    return `HTTP ${status ?? "desconocido"} - ${data ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
