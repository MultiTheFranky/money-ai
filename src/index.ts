import { getAccounts, getTransactions } from "./api";
import { parseTransactionsForAI } from "./parser";
import { SimplifiedTransaction } from "./types";

/**
 * Punto de entrada: obtiene las cuentas disponibles, extrae los movimientos
 * de los últimos días para cada una y muestra el resultado simplificado,
 * listo para ser consumido por un LLM.
 */
async function main(): Promise<void> {
  try {
    console.log("Conectando con Enable Banking...");

    const accountIds = await getAccounts();

    if (accountIds.length === 0) {
      console.log("No se encontraron cuentas asociadas a esta aplicación.");
      return;
    }

    console.log(`Cuentas encontradas: ${accountIds.length}`);

    const allTransactions: SimplifiedTransaction[] = [];

    for (const accountId of accountIds) {
      console.log(`Obteniendo movimientos de la cuenta ${accountId}...`);
      const rawTransactions = await getTransactions(accountId);
      const simplified = parseTransactionsForAI(rawTransactions);
      allTransactions.push(...simplified);
    }

    console.log("Movimientos bancarios (formato listo para IA):");
    console.log(JSON.stringify(allTransactions, null, 2));
  } catch (error) {
    console.error(
      "Error en la ejecución principal:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  }
}

main();
