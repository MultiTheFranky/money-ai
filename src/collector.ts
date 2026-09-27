import { AspspRateLimitError, getTransactions } from "./api";
import { requireLinkedSession } from "./bankSession";
import { config } from "./config";
import { logger } from "./logger";
import { parseTransactionsForAI, resolveAccountMeta } from "./parser";
import { getCachedTransactions, getRateLimitCooldownMs, setCachedTransactions, setRateLimited } from "./transactionsCache";
import { SimplifiedTransaction } from "./types";

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

// Evita llamadas simultáneas al banco (doble clic, "Cargar" y "Consultar IA" a la vez)
let inFlightCollection: Promise<CollectedTransactions> | null = null;

/**
 * Recorre todas las cuentas vinculadas y devuelve sus movimientos simplificados.
 * Reutiliza la caché si es reciente, respeta el cooldown tras un rate limit del banco y,
 * si la llamada falla, sirve la última copia cacheada aunque esté desactualizada.
 * `psuHeaders` vacío = acceso en segundo plano (cuenta para el límite diario PSD2).
 */
export function collectAllTransactions(psuHeaders: Record<string, string>): Promise<CollectedTransactions> {
  if (inFlightCollection) {
    logger.info("collector", "Ya hay una recolección de movimientos en curso, se reutiliza su resultado");
    return inFlightCollection;
  }
  inFlightCollection = doCollectAllTransactions(psuHeaders).finally(() => {
    inFlightCollection = null;
  });
  return inFlightCollection;
}

async function doCollectAllTransactions(psuHeaders: Record<string, string>): Promise<CollectedTransactions> {
  const session = requireLinkedSession();
  const allTransactions: SimplifiedTransaction[] = [];
  const accountErrors: AccountFetchError[] = [];
  const cacheTtlMs = config.transactionsCacheTtlMinutes * 60 * 1000;

  logger.info("collector", `Recolectando movimientos de ${session.accounts.length} cuenta(s) vinculada(s) (${session.aspspName}/${session.aspspCountry})`);

  for (const account of session.accounts) {
    const meta = resolveAccountMeta(account);
    const cached = getCachedTransactions(account.uid);

    if (cached && cached.ageMs < cacheTtlMs) {
      const simplified = parseTransactionsForAI(cached.transactions, meta);
      allTransactions.push(...simplified);
      logger.info(
        "collector",
        `Cuenta ${account.uid} (${meta.accountName}): ${simplified.length} movimientos servidos desde caché (edad=${Math.round(cached.ageMs / 1000)}s)`
      );
      continue;
    }

    const cooldownMs = getRateLimitCooldownMs(account.uid);
    if (cooldownMs !== null) {
      const remainingMin = Math.ceil(cooldownMs / 60000);
      logger.warn(
        "collector",
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
      const { transactions: rawTransactions, lookbackDays } = await getTransactions(account.uid, {
        psuHeaders,
        lookbackDays: cached?.lookbackDays,
      });
      setCachedTransactions(account.uid, rawTransactions, lookbackDays);
      const simplified = parseTransactionsForAI(rawTransactions, meta);
      allTransactions.push(...simplified);
      logger.info("collector", `Cuenta ${account.uid} (${meta.accountName}): ${simplified.length} movimientos`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("collector", `Falló la cuenta ${account.uid} (${meta.accountName}): ${message}`);

      if (error instanceof AspspRateLimitError) {
        setRateLimited(account.uid, config.rateLimitCooldownMinutes * 60 * 1000);
      }

      if (cached) {
        allTransactions.push(...parseTransactionsForAI(cached.transactions, meta));
        logger.warn("collector", `Cuenta ${account.uid}: se sirve caché desactualizada de ${cached.fetchedAt} tras el fallo`);
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

  logger.info("collector", `Total recolectado: ${allTransactions.length} movimientos, ${accountErrors.length} cuenta(s) con error`);
  return { transactions: allTransactions, accountErrors };
}
