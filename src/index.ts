import { getTransactions } from "./api";
import { BankNotLinkedError, requireLinkedSession } from "./bankSession";
import { parseTransactionsForAI } from "./parser";
import { SimplifiedTransaction } from "./types";

/**
 * Punto de entrada: usa la cuenta bancaria vinculada previamente desde el panel
 * web (`npm run dev`), extrae sus movimientos recientes y muestra el resultado
 * simplificado, listo para ser consumido por un LLM.
 */
async function main(): Promise<void> {
  try {
    console.log("Conectando con Enable Banking...");

    const session = requireLinkedSession();
    const accounts = session.accounts;

    console.log(`Cuentas vinculadas (${session.aspspName}, ${session.aspspCountry}): ${accounts.length}`);

    const allTransactions: SimplifiedTransaction[] = [];

    for (const account of accounts) {
      console.log(`Obteniendo movimientos de la cuenta ${account.uid}...`);
      const rawTransactions = await getTransactions(account.uid);
      const simplified = parseTransactionsForAI(rawTransactions);
      allTransactions.push(...simplified);
    }

    console.log("Movimientos bancarios (formato listo para IA):");
    console.log(JSON.stringify(allTransactions, null, 2));
  } catch (error) {
    if (error instanceof BankNotLinkedError) {
      console.error(
        `${error.message}\nEjecuta "npm run dev", inicia sesión en el panel y vincula tu banco antes de usar este script.`
      );
      process.exitCode = 1;
      return;
    }
    console.error(
      "Error en la ejecución principal:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  }
}

main();
