// Single-admin authentication: one admin account, password-hash storage
// (scrypt, no plaintext ever persisted), server-side sessions via an
// httpOnly cookie, and a password-reset flow. This module only issues the
// reset token; index.js emails it via mail.js and logs it as a fallback
// (`journalctl -u sem-meter`) in case SMTP is ever down or unconfigured.
import crypto from "node:crypto";
import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_user (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
`);

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getAdmin() {
  return db.prepare("SELECT * FROM admin_user WHERE id = 1").get();
}

/**
 * Create the single admin account with a random password the first time
 * the server ever runs. Returns the plaintext password only on that first
 * creation (it's never recoverable again — use the forgot-password flow
 * after that).
 */
export function initAuth(defaultEmail) {
  const existing = getAdmin();
  if (existing) return { created: false, email: existing.email };
  if (!defaultEmail) {
    throw new Error("No admin account yet: set ADMIN_EMAIL (in .env or the server's environment) to create one.");
  }

  const initialPassword = crypto.randomBytes(12).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO admin_user (id, email, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)").run(
    defaultEmail,
    hashPassword(initialPassword),
    now,
    now
  );
  return { created: true, email: defaultEmail, initialPassword };
}

export function login(email, password) {
  const row = getAdmin();
  if (!row || row.email.toLowerCase() !== String(email).toLowerCase()) return null;
  if (!verifyPassword(password, row.password_hash)) return null;

  const token = randomToken();
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)").run(
    token,
    now,
    now + SESSION_TTL_MS
  );
  return { token, email: row.email };
}

export function logout(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/** Returns the admin's email if `token` is a valid, unexpired session — else null. */
export function sessionEmail(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!row || row.expires_at < Date.now()) return null;
  return getAdmin()?.email ?? null;
}

/**
 * Generates a reset token if `email` matches the admin account, logging the
 * reset link server-side. Always returns null to the HTTP layer regardless
 * of whether it matched — callers must respond identically either way so a
 * request can't be used to probe whether an email is the admin's.
 */
export function requestPasswordReset(email) {
  const row = getAdmin();
  if (!row || row.email.toLowerCase() !== String(email).toLowerCase()) return null;
  const token = randomToken();
  const now = Date.now();
  db.prepare("INSERT INTO password_resets (token, created_at, expires_at, used) VALUES (?, ?, ?, 0)").run(
    token,
    now,
    now + RESET_TTL_MS
  );
  return token;
}

export function resetPassword(token, newPassword) {
  const row = db.prepare("SELECT * FROM password_resets WHERE token = ?").get(token);
  if (!row || row.used || row.expires_at < Date.now()) return false;
  db.prepare("UPDATE admin_user SET password_hash = ?, updated_at = ? WHERE id = 1").run(
    hashPassword(newPassword),
    Date.now()
  );
  db.prepare("UPDATE password_resets SET used = 1 WHERE token = ?").run(token);
  db.exec("DELETE FROM sessions"); // a reset invalidates every existing session
  return true;
}
