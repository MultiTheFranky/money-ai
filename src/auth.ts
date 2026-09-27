import * as fs from "fs/promises";
import jwt from "jsonwebtoken";
import { config } from "./config";

const TOKEN_TTL_SECONDS = 3600; // 1 hora

/**
 * Genera un JWT firmado con RS256 usando la clave privada de la aplicación,
 * según la especificación de autenticación de Enable Banking.
 */
export async function generateToken(): Promise<string> {
  try {
    const privateKey = await fs.readFile(config.keyPath, "utf8");

    const nowInSeconds = Math.floor(Date.now() / 1000);

    const payload = {
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: nowInSeconds,
      exp: nowInSeconds + TOKEN_TTL_SECONDS,
    };

    const token = jwt.sign(payload, privateKey, {
      algorithm: "RS256",
      header: {
        alg: "RS256",
        kid: config.clientId,
      },
    });

    return token;
  } catch (error) {
    throw new Error(
      `Error generando el token JWT para Enable Banking: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
