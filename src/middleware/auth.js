import { verifyAccessToken } from '../lib/auth.js'
import { prisma } from '../lib/prisma.js'
import { CURRENT_AGREEMENT_VERSION } from '../lib/agreement.js'

// Attaches req.auth = { id, role, adminRole?, orgId?, orgRole? } if a valid
// token is present. orgId / orgRole are the account's workspace (see
// lib/workspace.js); middleware/workspace.js turns them into req.ctx.
export function attachAuth(req, _res, next) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(header.slice(7))
      req.auth = {
        id: payload.sub,
        role: payload.role,
        adminRole: payload.adminRole,
        orgId: payload.orgId ?? null,
        orgRole: payload.orgRole ?? null,
      }
    } catch {
      // invalid/expired token — leave req.auth undefined
    }
  }
  next()
}

export function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Authentication required.' })
  next()
}

// Usage: requireRole('professional') or requireRole('admin', 'professional')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required.' })
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'You do not have access to this resource.' })
    }
    next()
  }
}

// Usage: requireAdminRole('PLATFORM_ADMIN', 'CLINICAL_SAFETY_REVIEWER')
export function requireAdminRole(...adminRoles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required.' })
    if (req.auth.role !== 'admin' || !adminRoles.includes(req.auth.adminRole)) {
      return res.status(403).json({
        error: 'Your admin role does not have access to this section.',
      })
    }
    next()
  }
}

// Blocks professional-facing clinical/business routes (referrals, clients,
// their own appointments) until the professional has accepted the current
// version of the professional agreement. A rejection here carries a `code`
// the frontend specifically checks for, so it can redirect to the
// acceptance screen instead of showing a generic error.
export function requireAgreement(req, res, next) {
  if (!req.auth || req.auth.role !== 'professional') {
    return res.status(401).json({ error: 'Authentication required.' })
  }

  prisma.professional
    .findUnique({
      where: { id: req.auth.id },
      select: { agreementAcceptedAt: true, agreementVersion: true },
    })
    .then((professional) => {
      if (!professional) return res.status(401).json({ error: 'Authentication required.' })

      const accepted =
        professional.agreementAcceptedAt !== null &&
        professional.agreementVersion === CURRENT_AGREEMENT_VERSION

      if (accepted) return next()

      return res.status(403).json({
        error: 'You must accept the professional agreement before continuing.',
        code: 'AGREEMENT_REQUIRED',
      })
    })
    .catch(next)
}
