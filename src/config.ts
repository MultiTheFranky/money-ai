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
  appUrl: string;
  appName: string;
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
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  appName: process.env.APP_NAME ?? "Money AI",
};
