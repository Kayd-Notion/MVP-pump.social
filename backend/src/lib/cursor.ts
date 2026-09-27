import { badRequest } from "./errors.js";

/**
 * Opaque keyset cursors: base64url(JSON) of the sort key of the last row
 * returned. Clients pass them back verbatim; they never see offsets.
 */
export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<K extends string>(raw: string | undefined, keys: K[]): Record<K, string> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (obj && keys.every((k) => typeof obj[k] === "string")) return obj;
  } catch {
    /* fall through */
  }
  throw badRequest("invalid_cursor", "Curseur invalide.");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NUMERIC_RE = /^\d+(\.\d+)?$/;
