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


/**
 * Obtiene las transacciones de una cuenta desde `dateFrom` (por defecto,
 * según config.defaultLookbackDays) hasta la fecha actual.
 *
 * Algunos ASPSP rechazan rangos amplios con 422 WRONG_TRANSACTIONS_PERIOD (varía según
 * banco y tipo de cuenta, p. ej. tarjetas). En ese caso se reintenta con ventanas cada vez
 * más cortas y, como último recurso, sin restricción de fecha (periodo por defecto del banco).
 */
export async function getTransactions(
  accountId: string,
  dateFrom?: string
): Promise<RawTransaction[]> {
  const headers = await buildAuthHeaders();
  const primaryFromDate = dateFrom ?? dateDaysAgo(config.defaultLookbackDays);

  // Solo se añaden ventanas de reintento estrictamente más cortas (fechas más recientes)
  // que la solicitud inicial, para no repetir un rango igual o más amplio ya rechazado
  const fallbackFromDates = [dateDaysAgo(90), dateDaysAgo(30)].filter(
    (candidate) => candidate > primaryFromDate
  );

  const attempts: Record<string, string>[] = [
    { date_from: primaryFromDate },
    ...fallbackFromDates.map((date_from) => ({ date_from })),
    {},
  ];

  logger.info(
    "api",
    `GET /accounts/${accountId}/transactions: ${attempts.length} ventana(s) a probar -> ${attempts
      .map((p) => p.date_from ?? "sin fecha")
      .join(" | ")}`
  );

  let lastError: unknown;

  for (const [index, params] of attempts.entries()) {
    logger.debug(
      "api",
      `Cuenta ${accountId}: intento ${index + 1}/${attempts.length} con date_from=${params.date_from ?? "(sin filtro)"}`
    );
    try {
      const transactions = await fetchTransactionsPage(accountId, headers, params);
      logger.info(
        "api",
        `Cuenta ${accountId}: ${transactions.length} movimientos obtenidos (intento ${index + 1}, date_from=${
          params.date_from ?? "sin filtro"
        })`
      );
      return transactions;
    } catch (error) {
      lastError = error;
      if (isAspspRateLimitError(error)) {
        logger.error("api", `Cuenta ${accountId}: rate limit del ASPSP: ${describeAxiosError(error)}`);
        throw new AspspRateLimitError(accountId, describeAxiosError(error));
      }
      if (!isWrongTransactionsPeriodError(error)) {
        logger.error("api", `Cuenta ${accountId}: error no recuperable: ${describeAxiosError(error)}`);
        throw new Error(
          `Error obteniendo transacciones de la cuenta ${accountId}: ${describeAxiosError(error)}`
        );
      }
      logger.warn(
        "api",
        `Cuenta ${accountId}: WRONG_TRANSACTIONS_PERIOD con date_from=${params.date_from ?? "sin filtro"}, se prueba la siguiente ventana`
      );
    }
  }

  logger.error("api", `Cuenta ${accountId}: se agotaron todas las ventanas de reintento`);
  throw new Error(
    `Error obteniendo transacciones de la cuenta ${accountId}: ${describeAxiosError(lastError)}`
  );
}

async function fetchTransactionsPage(
  accountId: string,
  headers: Record<string, string>,
  params: Record<string, string>
): Promise<RawTransaction[]> {
  const response = await axios.get<TransactionsResponse>(
    `${config.apiBaseUrl}/accounts/${accountId}/transactions`,
    { headers, params }
  );
  return response.data.transactions;
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
