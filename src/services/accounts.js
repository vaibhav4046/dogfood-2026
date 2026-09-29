"use strict";

const crypto = require("node:crypto");

const PASSWORD_N = 16384;
const SESSION_DAYS = 7;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function validEmail(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 1024;
}

function hashPassword(password) {
  if (!validatePassword(password)) throw new Error("Password must be 12 to 1024 characters.");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64, {
    N: PASSWORD_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  }).toString("hex");
  return `scrypt$${PASSWORD_N}$8$1$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string" || typeof password !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (n !== PASSWORD_N || r !== 8 || p !== 1) return false;
  const expected = Buffer.from(parts[5], "hex");
  if (expected.length !== 64) return false;
  const actual = crypto.scryptSync(password, parts[4], expected.length, {
    N: n, r, p, maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

function createAccount(db, { email, name, password, role = "participant" }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanName = String(name || "").trim();
  if (!validEmail(cleanEmail)) throw new Error("A valid email is required.");
  if (!cleanName || cleanName.length > 120) throw new Error("Name must be 1 to 120 characters.");
  if (!["participant", "judge", "organizer", "admin"].includes(role)) throw new Error("Invalid role.");
  const id = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db.prepare(`INSERT INTO users (id,email,name,role,login_key,created_at,password_hash)
              VALUES (?,?,?,?,NULL,?,?)`).run(
    id, cleanEmail, cleanName, role, new Date().toISOString(), hashPassword(password),
  );
  return { id, email: cleanEmail, name: cleanName, role };
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(`INSERT INTO sessions
    (token,user_id,created_at,expires_at,kind,max_expires_at,last_seen_at)
    VALUES (?,?,?,?,'real',?,?)`).run(
    hashToken(token), userId, now.toISOString(), expires, expires, now.toISOString(),
  );
  return token;
}

function revokeSession(db, token) {
  if (!token) return;
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE token = ? AND kind = 'real'")
    .run(new Date().toISOString(), hashToken(token));
}

module.exports = {
  hashToken, hashPassword, verifyPassword, validEmail, validatePassword,
  createAccount, createSession, revokeSession,
};
