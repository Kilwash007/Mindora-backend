import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const SALT_ROUNDS = 12
const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL_DAYS = 30

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS)
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash)
}

// Short-lived access token — sent on every API call, expires in 15 minutes.
// role: 'user' | 'professional' | 'admin' | 'org'
// adminRole (only for role 'admin'): 'PLATFORM_ADMIN' | 'CLINICAL_SAFETY_REVIEWER' | 'SUPPORT'
// orgId / orgRole: the workspace the account belongs to (lib/workspace.js).
// Left out entirely for Mindora Care accounts and Mindora admins.
export function signAccessToken({ id, role, adminRole, orgId, orgRole }) {
  const payload = { sub: id, role }
  if (adminRole) payload.adminRole = adminRole
  if (orgId && role !== 'admin') {
    payload.orgId = orgId
    payload.orgRole = orgRole
  }
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL })
}

export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

// Refresh token: a long random string, never a JWT — the actual value is
// only ever shown to the client once. The server only ever stores its hash.
export function generateRefreshTokenValue() {
  return crypto.randomBytes(48).toString('hex')
}

export function hashRefreshToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function refreshTokenExpiryDate() {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
}
