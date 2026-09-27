import axios, { AxiosError } from "axios";
import { generateToken } from "./auth";
import { config } from "./config";
import { logger } from "./logger";
import {
  AspspsResponse,
  AuthorizeSessionResponse,
  Aspsp,
  RawTransaction,
  StartAuthorizationResponse,
  TransactionsResponse,
} from "./types";

// Máxima validez del consentimiento solicitado al ASPSP (90 días)
const CONSENT_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

/** Se lanza cuando el ASPSP responde 429 ASPSP_RATE_LIMIT_EXCEEDED (límite de accesos del consentimiento) */
export class AspspRateLimitError extends Error {
  constructor(accountId: string, detail: string) {
    super(`El banco ha limitado los accesos a la cuenta ${accountId}: ${detail}`);
    this.name = "AspspRateLimitError";
  }
}

/** Construye los headers de autorización necesarios para llamar a la API */
async function buildAuthHeaders(): Promise<Record<string, string>> {
  const token = await generateToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/** Devuelve una fecha en formato YYYY-MM-DD, `daysAgo` días antes de hoy */
function dateDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split("T")[0];
}

/** Obtiene la lista de bancos (ASPSPs) disponibles, opcionalmente filtrados por país */
export async function getAspsps(country?: string): Promise<Aspsp[]> {
  logger.info("api", `GET /aspsps (country=${country ?? "todos"})`);
  try {
    const headers = await buildAuthHeaders();

    const response = await axios.get<AspspsResponse>(`${config.apiBaseUrl}/aspsps`, {
      headers,
      params: country ? { country } : undefined,
    });

    logger.info("api", `GET /aspsps -> ${response.data.aspsps.length} bancos encontrados`);
    return response.data.aspsps;
  } catch (error) {
    logger.error("api", `GET /aspsps falló: ${describeAxiosError(error)}`);
    throw new Error(`Error obteniendo la lista de bancos: ${describeAxiosError(error)}`);
  }
}

/**
 * Inicia el flujo de autorización con un ASPSP concreto y devuelve la URL a la que
 * hay que redirigir al usuario para que autorice el acceso a sus cuentas.
 */
export async function startBankAuthorization(
  aspspName: string,
  aspspCountry: string,
  state: string
): Promise<StartAuthorizationResponse> {
  logger.info("api", `POST /auth (aspsp=${aspspName}/${aspspCountry}, redirect_url=${config.enableBankingRedirectUrl})`);
  try {
    const headers = await buildAuthHeaders();
    const validUntil = new Date(Date.now() + CONSENT_VALIDITY_MS).toISOString();

    const response = await axios.post<StartAuthorizationResponse>(
      `${config.apiBaseUrl}/auth`,
      {
        access: { valid_until: validUntil },
        aspsp: { name: aspspName, country: aspspCountry },
        state,
        redirect_url: config.enableBankingRedirectUrl,
        psu_type: "personal",
      },
      { headers }
    );

    logger.info("api", `POST /auth -> authorization_id=${response.data.authorization_id}, url=${response.data.url}`);
    return response.data;
  } catch (error) {
    logger.error("api", `POST /auth falló: ${describeAxiosError(error)}`);
    throw new Error(`Error iniciando la autorización bancaria: ${describeAxiosError(error)}`);
  }
}

/**
 * Completa la autorización con el `code` devuelto en el callback y obtiene la
 * sesión autorizada junto con la lista de cuentas accesibles.
 */
export async function completeBankAuthorization(code: string): Promise<AuthorizeSessionResponse> {
  logger.info("api", `POST /sessions (code recibido, longitud=${code.length})`);
  try {
    const headers = await buildAuthHeaders();

    const response = await axios.post<AuthorizeSessionResponse>(
      `${config.apiBaseUrl}/sessions`,
      { code },
      { headers }
    );

    logger.info(
      "api",
      `POST /sessions -> session_id=${response.data.session_id}, ${response.data.accounts.length} cuentas (${response.data.aspsp.name}/${response.data.aspsp.country})`
    );
    return response.data;
  } catch (error) {
    logger.error("api", `POST /sessions falló: ${describeAxiosError(error)}`);
    throw new Error(`Error completando la autorización bancaria: ${describeAxiosError(error)}`);
  }
}


export interface GetTransactionsOptions {
  /** Cabeceras Psu-* que indican al banco que el usuario está presente (no cuentan como acceso en segundo plano) */
  psuHeaders?: Record<string, string>;
  /** Ventana en días que ya funcionó para esta cuenta; null = sin filtro de fecha */
  lookbackDays?: number | null;
}

export interface TransactionsResult {
  transactions: RawTransaction[];
  /** Ventana que ha funcionado, para reutilizarla y no repetir intentos rechazados */
  lookbackDays: number | null;
}

/**
 * Obtiene las transacciones de una cuenta. Algunos ASPSP rechazan rangos amplios con
 * 422 WRONG_TRANSACTIONS_PERIOD; en ese caso se prueban ventanas más cortas. Cada intento
 * cuenta como un acceso al consentimiento, por eso el llamante debe pasar `lookbackDays`
 * con la ventana que ya funcionó y así ir directo a ella.
 */
export async function getTransactions(
  accountId: string,
  options: GetTransactionsOptions = {}
): Promise<TransactionsResult> {
  const authHeaders = await buildAuthHeaders();
  const startDays = options.lookbackDays === undefined ? config.defaultLookbackDays : options.lookbackDays;
  const windows: (number | null)[] =
    startDays === null ? [null] : [startDays, ...[90, 30].filter((days) => days < startDays), null];
  let psuHeaders = options.psuHeaders ?? {};

  logger.info(
    "api",
    `GET /accounts/${accountId}/transactions: ventanas ${windows.map((d) => (d === null ? "sin fecha" : `${d}d`)).join(" | ")}, cabeceras PSU=${
      Object.keys(psuHeaders).length > 0 ? "sí" : "no"
    }`
  );

  let lastError: unknown;
  let index = 0;

  while (index < windows.length) {
    const days = windows[index];
    const params: Record<string, string> = days === null ? {} : { date_from: dateDaysAgo(days) };
    logger.debug("api", `Cuenta ${accountId}: intento con ventana ${days === null ? "sin filtro" : `${days}d`}`);

    try {
      const transactions = await fetchAllTransactionPages(accountId, { ...authHeaders, ...psuHeaders }, params);
      logger.info(
        "api",
        `Cuenta ${accountId}: ${transactions.length} movimientos obtenidos (ventana ${days === null ? "sin filtro" : `${days}d`})`
      );
      return { transactions, lookbackDays: days };
    } catch (error) {
      lastError = error;
      if (isAspspRateLimitError(error)) {
        logger.error("api", `Cuenta ${accountId}: rate limit del ASPSP: ${describeAxiosError(error)}`);
        throw new AspspRateLimitError(accountId, describeAxiosError(error));
      }
      if (isPsuHeaderError(error) && Object.keys(psuHeaders).length > 0) {
        // El banco exige otro juego de cabeceras PSU; se reintenta la misma ventana sin ellas
        logger.warn("api", `Cuenta ${accountId}: cabeceras PSU rechazadas (${describeAxiosError(error)}), se reintenta sin ellas`);
        psuHeaders = {};
        continue;
      }
      if (!isWrongTransactionsPeriodError(error)) {
        logger.error("api", `Cuenta ${accountId}: error no recuperable: ${describeAxiosError(error)}`);
        throw new Error(
          `Error obteniendo transacciones de la cuenta ${accountId}: ${describeAxiosError(error)}`
        );
      }
      logger.warn(
        "api",
        `Cuenta ${accountId}: WRONG_TRANSACTIONS_PERIOD con ventana ${days === null ? "sin filtro" : `${days}d`}, se prueba la siguiente`
      );
      index++;
    }
  }

  logger.error("api", `Cuenta ${accountId}: se agotaron todas las ventanas de reintento`);
  throw new Error(
    `Error obteniendo transacciones de la cuenta ${accountId}: ${describeAxiosError(lastError)}`
  );
}

// Tope de seguridad por si el banco devolviera continuation_key indefinidamente
const MAX_TRANSACTION_PAGES = 50;

/** Descarga todas las páginas de movimientos siguiendo `continuation_key` hasta que el banco deje de enviarlo */
async function fetchAllTransactionPages(
  accountId: string,
  headers: Record<string, string>,
  params: Record<string, string>
): Promise<RawTransaction[]> {
  const allTransactions: RawTransaction[] = [];
  const seenKeys = new Set<string>();
  let continuationKey: string | undefined;

  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page++) {
    const response = await axios.get<TransactionsResponse>(
      `${config.apiBaseUrl}/accounts/${accountId}/transactions`,
      { headers, params: continuationKey ? { ...params, continuation_key: continuationKey } : params }
    );

    allTransactions.push(...response.data.transactions);
    continuationKey = response.data.continuation_key ?? undefined;
    logger.debug(
      "api",
      `Cuenta ${accountId}: página ${page} -> ${response.data.transactions.length} movimientos${continuationKey ? ", hay más páginas" : ", última página"}`
    );

    if (!continuationKey) {
      return allTransactions;
    }
    if (seenKeys.has(continuationKey)) {
      logger.warn("api", `Cuenta ${accountId}: continuation_key repetido, se detiene la paginación`);
      return allTransactions;
    }
    seenKeys.add(continuationKey);
  }

  logger.warn("api", `Cuenta ${accountId}: se alcanzó el tope de ${MAX_TRANSACTION_PAGES} páginas, resultado posiblemente incompleto`);
  return allTransactions;
}

function isWrongTransactionsPeriodError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 422) {
    return false;
  }
  const data = error.response?.data as { error?: string } | undefined;
  return data?.error === "WRONG_TRANSACTIONS_PERIOD";
}

function isAspspRateLimitError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) {
    return false;
  }
  const data = error.response?.data as { error?: string } | undefined;
  return data?.error === "ASPSP_RATE_LIMIT_EXCEEDED";
}

function isPsuHeaderError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  const data = error.response?.data as { error?: string } | undefined;
  return data?.error === "PSU_HEADER_NOT_PROVIDED" || data?.error === "PSU_HEADER_INVALID";
}

/** Extrae un mensaje de error legible a partir de un error de axios o genérico */
function describeAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const data = JSON.stringify(axiosError.response?.data);
    return `HTTP ${status ?? "desconocido"} - ${data ?? axiosError.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
