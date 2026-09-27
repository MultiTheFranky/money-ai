import { RawTransaction, SimplifiedTransaction } from "./types";

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

/**
 * Limpia y transforma las transacciones crudas de Enable Banking en objetos
 * simplificados, listos para ser enviados a un LLM u otro sistema de análisis.
 */
export function parseTransactionsForAI(
  rawTransactions: RawTransaction[]
): SimplifiedTransaction[] {
  return rawTransactions.map((transaction) => ({
    date: resolveDate(transaction),
    amount: resolveSignedAmount(transaction),
    currency: transaction.transaction_amount.currency,
    concept: resolveConcept(transaction),
  }));
}
