import axios, { AxiosError } from "axios";
import { generateToken } from "./auth";
import { config } from "./config";
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
  try {
    const headers = await buildAuthHeaders();

    const response = await axios.get<AspspsResponse>(`${config.apiBaseUrl}/aspsps`, {
      headers,
      params: country ? { country } : undefined,
    });

    return response.data.aspsps;
  } catch (error) {
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

    return response.data;
  } catch (error) {
    throw new Error(`Error iniciando la autorización bancaria: ${describeAxiosError(error)}`);
  }
}

/**
 * Completa la autorización con el `code` devuelto en el callback y obtiene la
 * sesión autorizada junto con la lista de cuentas accesibles.
 */
export async function completeBankAuthorization(code: string): Promise<AuthorizeSessionResponse> {
  try {
    const headers = await buildAuthHeaders();

    const response = await axios.post<AuthorizeSessionResponse>(
      `${config.apiBaseUrl}/sessions`,
      { code },
      { headers }
    );

    return response.data;
  } catch (error) {
    throw new Error(`Error completando la autorización bancaria: ${describeAxiosError(error)}`);
  }
}


/**
 * Obtiene las transacciones de una cuenta desde `dateFrom` (por defecto,
 * según config.defaultLookbackDays) hasta la fecha actual.
 *
 * Usa la estrategia "longest" para que Enable Banking negocie con el ASPSP el mayor
 * periodo disponible sin exceder lo solicitado. Si aun así el banco rechaza el rango
 * (422 WRONG_TRANSACTIONS_PERIOD, algo común según el ASPSP y el tipo de cuenta), se
 * reintenta sin restricciones de fecha para obtener el periodo por defecto del banco.
 */
export async function getTransactions(
  accountId: string,
  dateFrom?: string
): Promise<RawTransaction[]> {
  const headers = await buildAuthHeaders();
  const fromDate = dateFrom ?? dateDaysAgo(config.defaultLookbackDays);

  try {
    return await fetchTransactionsPage(accountId, headers, { date_from: fromDate, strategy: "longest" });
  } catch (error) {
    if (isWrongTransactionsPeriodError(error)) {
      try {
        return await fetchTransactionsPage(accountId, headers, {});
      } catch (fallbackError) {
        throw new Error(
          `Error obteniendo transacciones de la cuenta ${accountId}: ${describeAxiosError(fallbackError)}`
        );
      }
    }
    throw new Error(
      `Error obteniendo transacciones de la cuenta ${accountId}: ${describeAxiosError(error)}`
    );
  }
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
