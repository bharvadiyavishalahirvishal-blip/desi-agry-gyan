import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

export const SESSION_COOKIE = 'dag_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** scrypt hash: "scrypt:<saltHex>:<keyHex>" */
export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `scrypt:${salt}:${key}`;
}

export function verifyPin(pin, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, keyHex] = parts;
  let expected;
  try {
    expected = Buffer.from(keyHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const derived = crypto.scryptSync(String(pin), salt, expected.length);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function cookieOptions(req, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req),
    path: '/',
    maxAge: maxAgeMs
  };
}

export function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    createdAt,
    expiresAt
  );
  res.cookie(SESSION_COOKIE, token, cookieOptions(req, SESSION_TTL_MS));
  return token;
}

export function destroySession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function currentUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.mobile, u.created_at, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { id: row.id, name: row.name, mobile: row.mobile, createdAt: row.created_at };
}

export function attachUser(req, _res, next) {
  req.user = currentUser(req);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'unauthenticated', message: 'પહેલા લોગિન કરો.' } });
  }
  next();
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}
