import jwt from "jsonwebtoken";
import { config } from "./config";

const SESSION_TTL = "8h";

export interface LoginCredentials {
  username: string;
  password: string;
}

/** Valida las credenciales del panel web contra las configuradas en el entorno */
export function validateCredentials({ username, password }: LoginCredentials): boolean {
  return username === config.appUsername && password === config.appPassword;
}

/** Genera un JWT de sesión (HS256) que protege los endpoints /api/* del panel */
export function createSessionToken(username: string): string {
  return jwt.sign({ sub: username }, config.sessionSecret, {
    algorithm: "HS256",
    expiresIn: SESSION_TTL,
  });
}

/** Verifica un JWT de sesión emitido por createSessionToken */
export function verifySessionToken(token: string): boolean {
  try {
    jwt.verify(token, config.sessionSecret);
    return true;
  } catch {
    return false;
  }
}
