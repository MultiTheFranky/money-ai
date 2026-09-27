import jwt from "jsonwebtoken";
import { config } from "./config";
import { logger } from "./logger";

const SESSION_TTL = "8h";

export interface LoginCredentials {
  username: string;
  password: string;
}

/** Valida las credenciales del panel web contra las configuradas en el entorno */
export function validateCredentials({ username, password }: LoginCredentials): boolean {
  const valid = username === config.appUsername && password === config.appPassword;
  logger.info("sessionAuth", `Intento de login de usuario "${username}" -> ${valid ? "correcto" : "incorrecto"}`);
  return valid;
}

/** Genera un JWT de sesión (HS256) que protege los endpoints /api/* del panel */
export function createSessionToken(username: string): string {
  logger.debug("sessionAuth", `Generando JWT de sesión (HS256, TTL=${SESSION_TTL}) para "${username}"`);
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
  } catch (error) {
    logger.warn("sessionAuth", `JWT de sesión inválido o expirado: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
