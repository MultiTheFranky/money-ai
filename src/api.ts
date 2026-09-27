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

const DEFAULT_LOOKBACK_DAYS = 7;
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
 * los últimos 7 días) hasta la fecha actual.
 */
export async function getTransactions(
  accountId: string,
  dateFrom?: string
): Promise<RawTransaction[]> {
  try {
    const headers = await buildAuthHeaders();
    const fromDate = dateFrom ?? dateDaysAgo(DEFAULT_LOOKBACK_DAYS);

    const response = await axios.get<TransactionsResponse>(
      `${config.apiBaseUrl}/accounts/${accountId}/transactions`,
      {
        headers,
        params: {
          date_from: fromDate,
        },
      }
    );

    return response.data.transactions;
  } catch (error) {
    throw new Error(
      `Error obteniendo transacciones de la cuenta ${accountId}: ${describeAxiosError(
        error
      )}`
    );
  }
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
