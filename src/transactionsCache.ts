import fs from "fs";
import path from "path";
import { logger } from "./logger";
import { RawTransaction } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "transactions-cache.json");

interface CacheEntry {
  fetchedAt?: string;
  transactions?: RawTransaction[];
  rateLimitedUntil?: string;
}

type CacheFile = Record<string, CacheEntry>;

function readCache(): CacheFile {
  if (!fs.existsSync(CACHE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as CacheFile;
  } catch (error) {
    logger.warn("transactionsCache", `No se pudo leer la caché, se ignora: ${error instanceof Error ? error.message : error}`);
    return {};
  }
}

function writeCache(cache: CacheFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
}

export interface CachedTransactions {
  transactions: RawTransaction[];
  fetchedAt: string;
  ageMs: number;
}

/** Devuelve la última copia cacheada de una cuenta (o null si nunca se cacheó nada) */
export function getCachedTransactions(accountId: string): CachedTransactions | null {
  const entry = readCache()[accountId];
  if (!entry?.transactions || !entry.fetchedAt) {
    return null;
  }
  return {
    transactions: entry.transactions,
    fetchedAt: entry.fetchedAt,
    ageMs: Date.now() - new Date(entry.fetchedAt).getTime(),
  };
}

/** Guarda la última copia obtenida con éxito de una cuenta, para poder servirla si el banco limita el acceso */
export function setCachedTransactions(accountId: string, transactions: RawTransaction[]): void {
  const cache = readCache();
  cache[accountId] = { ...cache[accountId], fetchedAt: new Date().toISOString(), transactions };
  writeCache(cache);
  logger.debug("transactionsCache", `Cuenta ${accountId}: ${transactions.length} movimientos guardados en caché`);
}

/**
 * Devuelve los milisegundos restantes de cooldown por rate limit de una cuenta, o null si
 * no está en cooldown (nunca se limitó o el cooldown ya expiró).
 */
export function getRateLimitCooldownMs(accountId: string): number | null {
  const rateLimitedUntil = readCache()[accountId]?.rateLimitedUntil;
  if (!rateLimitedUntil) {
    return null;
  }
  const remainingMs = new Date(rateLimitedUntil).getTime() - Date.now();
  return remainingMs > 0 ? remainingMs : null;
}

/** Marca una cuenta en cooldown tras recibir un rate limit del ASPSP, evitando nuevas llamadas hasta entonces */
export function setRateLimited(accountId: string, cooldownMs: number): void {
  const cache = readCache();
  const rateLimitedUntil = new Date(Date.now() + cooldownMs).toISOString();
  cache[accountId] = { ...cache[accountId], rateLimitedUntil };
  writeCache(cache);
  logger.warn("transactionsCache", `Cuenta ${accountId}: en cooldown por rate limit hasta ${rateLimitedUntil}`);
}
