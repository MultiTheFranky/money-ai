import axios from "axios";
import { config } from "./config";
import { SimplifiedTransaction } from "./types";

/**
 * Envía las transacciones simplificadas a OpenRouter y devuelve el análisis
 * del asesor financiero en formato Markdown.
 */
export async function analyzeTransactionsWithAI(
  transactions: SimplifiedTransaction[]
): Promise<string> {
  if (!config.openRouterApiKey) {
    throw new Error("Falta configurar la variable de entorno OPENROUTER_API_KEY");
  }

  const userMessage = `Estos son mis movimientos bancarios recientes (JSON):\n\n${JSON.stringify(
    transactions,
    null,
    2
  )}\n\nAnaliza mi gasto, avísame de excesos y dame recomendaciones concisas.`;

  try {
    const response = await axios.post(
      config.openRouterUrl,
      {
        model: config.openRouterModel,
        messages: [
          { role: "system", content: config.openRouterSystemPrompt },
          { role: "user", content: userMessage },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
          // Cabeceras exigidas por OpenRouter para identificar la app llamante
          "HTTP-Referer": config.appUrl,
          "X-Title": config.appName,
        },
      }
    );


    const content = response.data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("OpenRouter no devolvió contenido en la respuesta");
    }

    return content as string;
  } catch (error) {
    throw new Error(`Error consultando OpenRouter: ${describeError(error)}`);
  }
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = JSON.stringify(error.response?.data);
    return `HTTP ${status ?? "desconocido"} - ${data ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
