import { BankNotLinkedError } from "./bankSession";
import { collectAllTransactions } from "./collector";

/**
 * Punto de entrada: usa la cuenta bancaria vinculada previamente desde el panel
 * web (`npm run dev`), extrae sus movimientos recientes y muestra el resultado
 * simplificado, listo para ser consumido por un LLM.
 *
 * Comparte caché y cooldown con el servidor: solo llama al banco si la caché ha caducado.
 * Al no haber navegador no se envían cabeceras PSU, así que cada llamada real al banco
 * cuenta para el límite diario PSD2 de accesos en segundo plano.
 */
async function main(): Promise<void> {
  try {
    console.log("Obteniendo movimientos (caché compartida con el servidor)...");

    const { transactions, accountErrors } = await collectAllTransactions({});

    for (const accountError of accountErrors) {
      console.warn(`⚠️ ${accountError.accountName}: ${accountError.message}`);
    }

    console.log(`Movimientos bancarios (formato listo para IA): ${transactions.length}`);
    console.log(JSON.stringify(transactions, null, 2));
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
