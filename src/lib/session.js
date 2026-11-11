import { prisma } from './prisma.js'
import {
  signAccessToken,
  generateRefreshTokenValue,
  hashRefreshToken,
  refreshTokenExpiryDate,
} from './auth.js'
import { workspaceClaims } from './workspace.js'

// Issues a fresh access + refresh token pair for a given account, and
// stores the refresh token's hash so it can later be looked up and revoked.
// orgId / orgRole come from workspaceClaims (lib/workspace.js); leave them
// out for Mindora Care accounts and Mindora admins.
export async function issueSession({ id, role, adminRole, orgId, orgRole }) {
  const accessToken = signAccessToken({ id, role, adminRole, orgId, orgRole })

  const refreshValue = generateRefreshTokenValue()
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashRefreshToken(refreshValue),
      role,
      accountId: id,
      expiresAt: refreshTokenExpiryDate(),
    },
  })

  return { accessToken, refreshToken: refreshValue }
}

// Exchanges a valid, unrevoked refresh token for a new access token. Also
// rotates the refresh token itself (issues a new one, revokes the old) —
// this means a stolen refresh token can only be used once before the
// legitimate owner's next refresh silently invalidates it, limiting the
// damage window if one ever leaks.
//
// The workspace is worked out again here rather than copied from the old
// token, so a membership that has ended, or a workspace that has been
// suspended or closed, stops the session at the next refresh.
export async function refreshSession(refreshValue) {
  const tokenHash = hashRefreshToken(refreshValue)
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } })

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return null
  }

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })

  let adminRole
  if (stored.role === 'admin') {
    const admin = await prisma.admin.findUnique({ where: { id: stored.accountId } })
    if (!admin) return null
    adminRole = admin.role
  }

  if (stored.role === 'org') {
    const orgAdmin = await prisma.orgAdmin.findUnique({
      where: { id: stored.accountId },
      select: { deletedAt: true },
    })
    if (!orgAdmin || orgAdmin.deletedAt) return null
  }

  const claims = await workspaceClaims(stored.role, stored.accountId)
  if (!claims.ok) return null

  return issueSession({
    id: stored.accountId,
    role: stored.role,
    adminRole,
    orgId: claims.orgId,
    orgRole: claims.orgRole,
  })
}

// Revokes one specific refresh token — used on logout.
export async function revokeRefreshToken(refreshValue) {
  const tokenHash = hashRefreshToken(refreshValue)
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

// Revokes every active refresh token for an account — "log out everywhere."
export async function revokeAllSessions(role, accountId) {
  await prisma.refreshToken.updateMany({
    where: { role, accountId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
