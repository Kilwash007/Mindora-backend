import { prisma } from './prisma.js'

// Mindora for Institutions: which workspace an account belongs to.
//
// Every account is either in Mindora Care (no workspace, as before) or in
// exactly one institution's workspace, through its OrganizationMembership:
//   user         -> ORG_PATIENT
//   professional -> ORG_CLINICIAN
//   org          -> ORG_OWNER or ORG_ADMIN (an OrgAdmin account)
// Mindora's own admins ('admin') are never in a workspace.
//
// The answer is put into the access token as orgId / orgRole at login and
// worked out again on every refresh (lib/session.js), so ending someone's
// membership or suspending a workspace takes effect within one access
// token's life (15 minutes).

export const OPEN_STATUSES = ['TRIAL', 'ACTIVE']

const ACCOUNT_COLUMN = { user: 'userId', professional: 'professionalId', org: 'orgAdminId' }

// Returns one of:
//   { ok: true, orgId: null, orgRole: null, orgName: null }  Mindora Care
//   { ok: true, orgId, orgRole, orgName }                     an active member
//   { ok: false, status, code, error }                        can't sign in now
export async function workspaceClaims(role, accountId, client = prisma) {
  const care = { ok: true, orgId: null, orgRole: null, orgName: null }
  const column = ACCOUNT_COLUMN[role]
  if (!column) return care

  const membership = await client.organizationMembership.findUnique({
    where: { [column]: accountId },
    select: { role: true, active: true, organization: { select: { id: true, name: true, status: true } } },
  })

  if (!membership) {
    // An institution admin only exists to run a workspace.
    if (role === 'org') {
      return {
        ok: false,
        status: 403,
        code: 'WORKSPACE_REQUIRED',
        error: 'This account is not linked to a workspace. Please contact Mindora support.',
      }
    }
    return care
  }

  const { organization } = membership
  if (!membership.active) {
    return {
      ok: false,
      status: 403,
      code: 'WORKSPACE_ACCESS_ENDED',
      error: `Your access through ${organization.name} has ended. Please contact them if you think this is a mistake.`,
    }
  }
  if (!OPEN_STATUSES.includes(organization.status)) {
    return {
      ok: false,
      status: 403,
      code: 'WORKSPACE_UNAVAILABLE',
      error: `${organization.name}'s workspace is not available right now. Please contact them.`,
    }
  }

  return { ok: true, orgId: organization.id, orgRole: membership.role, orgName: organization.name }
}

// ---------------------------------------------------------------------------
// Who belongs to a scope. Accounts (User, Professional) are not tenant
// tables, so db() does not filter them; these filters do. Pass the scope's
// orgId: null means Mindora Care.
//
//   Mindora Care -> accounts with no workspace membership at all
//   a workspace  -> accounts with an ACTIVE membership in that workspace
//
// Use them wherever accounts are listed or picked: the professional
// directory, booking, triage rotas and alerts, and Mindora's admin pages.
// ---------------------------------------------------------------------------

export function professionalScope(orgId) {
  return orgId
    ? { orgMembership: { is: { organizationId: orgId, active: true } } }
    : { orgMembership: { is: null } }
}

export function userScope(orgId) {
  return orgId
    ? { orgMembership: { is: { organizationId: orgId, active: true } } }
    : { orgMembership: { is: null } }
}
