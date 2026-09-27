/**
 * Tipos e interfaces para la integración con la API de Enable Banking.
 * https://api.enablebanking.com
 */

/** Cuenta bancaria (AccountResource) tal como la devuelve POST /sessions al autorizar el acceso */
export interface EnableBankingAccount {
  uid: string;
  account_id: {
    iban?: string;
    other?: {
      identification: string;
      scheme_name?: string;
    };
  };
  account_servicer?: {
    bic_fi?: string;
    name?: string;
  };
  currency?: string;
  name?: string;
  product?: string;
  cash_account_type?: string;
  status?: string;
  [key: string]: unknown;
}

/** Banco (ASPSP) tal como lo devuelve el endpoint GET /aspsps */
export interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  [key: string]: unknown;
}

/** Respuesta cruda del endpoint GET /aspsps */
export interface AspspsResponse {
  aspsps: Aspsp[];
}

/** Respuesta de POST /auth: URL a la que redirigir al usuario para autorizar el acceso */
export interface StartAuthorizationResponse {
  url: string;
  authorization_id: string;
  psu_id_hash?: string;
}

/** Respuesta de POST /sessions: sesión autorizada junto con las cuentas accesibles */
export interface AuthorizeSessionResponse {
  session_id: string;
  accounts: EnableBankingAccount[];
  aspsp: Aspsp;
  psu_type: string;
  access: {
    valid_until: string;
  };
}

/** Importe con signo y divisa tal como lo modela Enable Banking */
export interface TransactionAmount {
  amount: string;
  currency: string;
}

/** Información de la contraparte de una transacción */
export interface TransactionCounterparty {
  name?: string;
  account_id?: {
    iban?: string;
    other?: {
      identification: string;
    };
  };
}

/** Transacción cruda tal como la devuelve el endpoint GET /accounts/{id}/transactions */
export interface RawTransaction {
  entry_reference?: string;
  transaction_amount: TransactionAmount;
  credit_debit_indicator?: "CRDT" | "DBIT";
  status?: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  remittance_information?: string[];
  creditor?: TransactionCounterparty;
  debtor?: TransactionCounterparty;
  bank_transaction_code?: string;
  [key: string]: unknown;
}

/** Respuesta cruda del endpoint GET /accounts/{id}/transactions */
export interface TransactionsResponse {
  transactions: RawTransaction[];
  continuation_key?: string;
}

/** Objeto simplificado y listo para enviar a un LLM u otro sistema de análisis */
export interface SimplifiedTransaction {
  date: string;
  amount: number;
  currency: string;
  concept: string;
  /** Nombre/alias de la cuenta o tarjeta de origen (p. ej. "Tarjeta Visa ****1234") */
  accountName?: string;
  /** Tipo de cuenta tal como lo informa Enable Banking (CACC, CARD, SVGS, ...) */
  accountType?: string;
}
