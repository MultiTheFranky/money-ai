/**
 * Tipos e interfaces para la integración con la API de Enable Banking.
 * https://api.enablebanking.com
 */

/** Cuenta bancaria tal como la devuelve el endpoint GET /accounts */
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

/** Respuesta cruda del endpoint GET /accounts */
export interface AccountsResponse {
  accounts: EnableBankingAccount[];
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
}
