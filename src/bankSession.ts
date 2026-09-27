import fs from "fs";
import path from "path";
import { EnableBankingAccount } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSION_FILE = path.join(DATA_DIR, "bank-session.json");

/** Sesión de Enable Banking ya autorizada por el usuario, persistida en disco */
export interface LinkedBankSession {
  sessionId: string;
  accounts: EnableBankingAccount[];
  aspspName: string;
  aspspCountry: string;
  linkedAt: string;
}

/** Se lanza cuando se necesita una cuenta vinculada pero todavía no existe ninguna */
export class BankNotLinkedError extends Error {
  constructor() {
    super("No hay ninguna cuenta bancaria vinculada. Vincúlala desde el panel antes de continuar.");
    this.name = "BankNotLinkedError";
  }
}

// Estado efímero (en memoria) del "state" pendiente durante el roundtrip OAuth-like de /auth -> /sessions
let pendingState: string | null = null;

export function setPendingState(state: string): void {
  pendingState = state;
}

/** Valida y consume el "state" pendiente (uso único, protege frente a CSRF) */
export function consumePendingState(state: string): boolean {
  const matches = pendingState !== null && pendingState === state;
  pendingState = null;
  return matches;
}

export function setLinkedSession(session: LinkedBankSession): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
}

export function getLinkedSession(): LinkedBankSession | null {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }
  const raw = fs.readFileSync(SESSION_FILE, "utf8");
  return JSON.parse(raw) as LinkedBankSession;
}

export function clearLinkedSession(): void {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
  }
}

/** Devuelve la sesión vinculada o lanza BankNotLinkedError si todavía no se ha vinculado ninguna */
export function requireLinkedSession(): LinkedBankSession {
  const session = getLinkedSession();
  if (!session) {
    throw new BankNotLinkedError();
  }
  return session;
}
