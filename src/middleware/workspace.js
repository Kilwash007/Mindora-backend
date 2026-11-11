// Sets req.ctx, the workspace a request acts in, from the verified access
// token (attachAuth runs first). Everything that reads or writes tenant
// records passes req.ctx to db() (lib/db.js).
//
//   req.ctx = {
//     accountId, accountRole,   // from the token; null when signed out
//     adminRole,                // Mindora admins only
//     orgId,                    // null = Mindora Care
//     orgRole,                  // ORG_OWNER | ORG_ADMIN | ORG_CLINICIAN | ORG_PATIENT | null
//   }
//
// Signed-out requests and Mindora's own admins always act in Mindora Care.
// Workspace data stays with the institution; Mindora staff reach it only
// through deliberate platform routes (Organizations page, usage totals).
export function resolveWorkspace(req, _res, next) {
  const auth = req.auth
  const inWorkspace = auth && auth.role !== 'admin' && auth.orgId

  req.ctx = {
    accountId: auth?.id ?? null,
    accountRole: auth?.role ?? null,
    adminRole: auth?.role === 'admin' ? auth.adminRole ?? null : null,
    orgId: inWorkspace ? auth.orgId : null,
    orgRole: inWorkspace ? auth.orgRole ?? null : null,
  }
  next()
}

// Usage: requireOrgRole('ORG_OWNER', 'ORG_ADMIN')
export function requireOrgRole(...orgRoles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required.' })
    if (!req.ctx?.orgId || !orgRoles.includes(req.ctx.orgRole)) {
      return res.status(403).json({ error: 'You do not have access to this workspace resource.' })
    }
    next()
  }
}

// For Mindora Care features that workspace members don't get in Phase 1
// (support groups, Mindora AI, Student Rate, reviews, programme codes).
export function requireMindoraCare(req, res, next) {
  if (req.ctx?.orgId) {
    return res.status(403).json({
      error: 'This feature is not part of your organisation\'s workspace.',
      code: 'NOT_IN_WORKSPACE',
    })
  }
  next()
}
