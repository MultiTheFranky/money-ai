import { EnableBankingAccount, RawTransaction, SimplifiedTransaction } from "./types";

/**
 * Convierte el signo del importe según el indicador crédito/débito de Enable Banking.
 * CRDT (crédito/ingreso) -> positivo, DBIT (débito/gasto) -> negativo.
 */
function resolveSignedAmount(transaction: RawTransaction): number {
  const rawAmount = parseFloat(transaction.transaction_amount.amount);

  if (Number.isNaN(rawAmount)) {
    return 0;
  }

  if (transaction.credit_debit_indicator === "DBIT") {
    return -Math.abs(rawAmount);
  }

  if (transaction.credit_debit_indicator === "CRDT") {
    return Math.abs(rawAmount);
  }

  // Si no hay indicador, se respeta el signo original del importe
  return rawAmount;
}

/** Obtiene la mejor fecha disponible para la transacción */
function resolveDate(transaction: RawTransaction): string {
  return (
    transaction.booking_date ??
    transaction.value_date ??
    transaction.transaction_date ??
    ""
  );
}

/**
 * Extrae un concepto legible priorizando la información de remesa
 * (remittance_information) y usando el nombre de la contraparte como respaldo.
 */
function resolveConcept(transaction: RawTransaction): string {
  const remittanceInfo = transaction.remittance_information;
  if (remittanceInfo && remittanceInfo.length > 0) {
    return remittanceInfo.filter(Boolean).join(" ").trim();
  }

  const counterpartyName =
    transaction.creditor?.name ?? transaction.debtor?.name;
  if (counterpartyName) {
    return counterpartyName.trim();
  }

  return "Sin concepto";
}

/** Metadatos de la cuenta/tarjeta de origen, adjuntados a cada movimiento simplificado */
export interface AccountMeta {
  accountName?: string;
  accountType?: string;
}

/** Deriva un nombre legible y el tipo de cuenta (CACC, CARD, ...) a partir de un AccountResource */
export function resolveAccountMeta(account: EnableBankingAccount): AccountMeta {
  const iban = account.account_id?.iban;
  const maskedIban = iban ? `IBAN ****${iban.slice(-4)}` : undefined;

  return {
    accountName: account.name ?? account.product ?? maskedIban ?? "Cuenta",
    accountType: account.cash_account_type,
  };
}

/**
 * Limpia y transforma las transacciones crudas de Enable Banking en objetos
 * simplificados, listos para ser enviados a un LLM u otro sistema de análisis.
 */
export function parseTransactionsForAI(
  rawTransactions: RawTransaction[],
  accountMeta: AccountMeta = {}
): SimplifiedTransaction[] {
  return rawTransactions.map((transaction) => ({
    date: resolveDate(transaction),
    amount: resolveSignedAmount(transaction),
    currency: transaction.transaction_amount.currency,
    concept: resolveConcept(transaction),
    accountName: accountMeta.accountName,
    accountType: accountMeta.accountType,
  }));
}
