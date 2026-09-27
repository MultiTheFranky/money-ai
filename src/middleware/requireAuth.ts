import { NextFunction, Request, Response } from "express";
import { verifySessionToken } from "../sessionAuth";

const BEARER_PREFIX = "Bearer ";

/** Protege un endpoint exigiendo un JWT de sesión válido en el header Authorization */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    res.status(401).json({ error: "No autorizado: falta el token de sesión" });
    return;
  }

  const token = header.slice(BEARER_PREFIX.length);

  if (!verifySessionToken(token)) {
    res.status(401).json({ error: "No autorizado: token de sesión inválido o expirado" });
    return;
  }

  next();
}
