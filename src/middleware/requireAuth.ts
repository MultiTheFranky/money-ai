import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";
import { verifySessionToken } from "../sessionAuth";

const BEARER_PREFIX = "Bearer ";

/** Protege un endpoint exigiendo un JWT de sesión válido en el header Authorization */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    logger.warn("requireAuth", `${req.method} ${req.path}: sin header Authorization`);
    res.status(401).json({ error: "No autorizado: falta el token de sesión" });
    return;
  }

  const token = header.slice(BEARER_PREFIX.length);

  if (!verifySessionToken(token)) {
    logger.warn("requireAuth", `${req.method} ${req.path}: token de sesión inválido o expirado`);
    res.status(401).json({ error: "No autorizado: token de sesión inválido o expirado" });
    return;
  }

  next();
}
