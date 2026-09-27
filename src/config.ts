import * as dotenv from "dotenv";

dotenv.config();

/** Configuración de la aplicación cargada desde variables de entorno (.env) */
export interface AppConfig {
  clientId: string;
  keyPath: string;
  apiBaseUrl: string;
  port: number;
  appUsername: string;
  appPassword: string;
  sessionSecret: string;
  openRouterApiKey: string | undefined;
  openRouterUrl: string;
  openRouterModel: string;
  openRouterSystemPrompt: string;
  openRouterEmbeddingsUrl: string;
  openRouterEmbeddingModel: string;
  appUrl: string;
  appName: string;
  enableBankingRedirectUrl: string;
  defaultLookbackDays: number;
  ragTopK: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

const DEFAULT_OPENROUTER_SYSTEM_PROMPT = `Eres un asesor financiero personal experto y cercano.
Analiza los movimientos bancarios en formato JSON que te proporciona el usuario.
Tu respuesta debe:
- Resumir en qué categorías se ha ido el dinero.
- Avisar claramente de gastos excesivos, inusuales o recurrentes que podrían recortarse.
- Dar recomendaciones concisas y accionables para mejorar el ahorro.
Responde SIEMPRE en español y en formato Markdown, usando títulos, negritas y listas cortas.
Sé breve y directo, evita rodeos.`;

export const config: AppConfig = {
  clientId: requireEnv("CLIENT_ID"),
  keyPath: requireEnv("KEY_PATH"),
  apiBaseUrl: "https://api.enablebanking.com",
  port: Number(process.env.PORT ?? 3000),
  appUsername: requireEnv("APP_USERNAME"),
  appPassword: requireEnv("APP_PASSWORD"),
  sessionSecret: requireEnv("SESSION_SECRET"),
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  openRouterUrl: process.env.OPENROUTER_URL ?? "https://openrouter.ai/api/v1/chat/completions",
  openRouterModel: process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.1-8b-instruct",
  openRouterSystemPrompt: process.env.OPENROUTER_SYSTEM_PROMPT ?? DEFAULT_OPENROUTER_SYSTEM_PROMPT,
  openRouterEmbeddingsUrl: process.env.OPENROUTER_EMBEDDINGS_URL ?? "https://openrouter.ai/api/v1/embeddings",
  openRouterEmbeddingModel: process.env.OPENROUTER_EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  appName: process.env.APP_NAME ?? "Money AI",
  // URL registrada en Enable Banking a la que redirige tras la autorización del usuario
  // Debe coincidir EXACTAMENTE con una de las redirect_urls registradas para tu aplicación
  enableBankingRedirectUrl:
    process.env.ENABLEBANKING_REDIRECT_URL ??
    `${process.env.APP_URL ?? "http://localhost:3000"}/callback`,
  // Ventana de movimientos a recuperar por defecto (6 meses)
  defaultLookbackDays: Number(process.env.DEFAULT_LOOKBACK_DAYS ?? 180),
  // Nº de movimientos más relevantes que se recuperan del RAG para el análisis con IA
  ragTopK: Number(process.env.RAG_TOP_K ?? 40),
};
