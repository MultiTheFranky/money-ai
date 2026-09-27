import axios, { AxiosError } from "axios";
import { generateToken } from "./auth";
import { config } from "./config";
import {
  AccountsResponse,
  RawTransaction,
  TransactionsResponse,
} from "./types";

const DEFAULT_LOOKBACK_DAYS = 7;

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

/**
 * Obtiene la lista de cuentas bancarias disponibles para la sesión autenticada
 * y devuelve un array con sus `account_id` (uid interno de Enable Banking).
 */
export async function getAccounts(): Promise<string[]> {
  try {
    const headers = await buildAuthHeaders();

    const response = await axios.get<AccountsResponse>(
      `${config.apiBaseUrl}/accounts`,
      { headers }
    );

    return response.data.accounts.map((account) => account.uid);
  } catch (error) {
    throw new Error(`Error obteniendo cuentas: ${describeAxiosError(error)}`);
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
