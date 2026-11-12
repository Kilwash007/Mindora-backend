import crypto from 'crypto'
import { prisma } from './prisma.js'
import { sendInviteEmail } from './email.js'
import { OPEN_STATUSES } from './workspace.js'
import { HttpError } from './wrap.js'

// Workspace invitations (Mindora for Institutions).
//
// An invite is a one-time link, valid for INVITE_TTL_DAYS. Only the SHA-256
// hash of its token is stored; the link itself exists only in the invite
// email and in the answer to the admin who created it (so it can be copied
// and sent another way, for example while email delivery is limited).
//
// Who may invite whom:
//   Mindora platform admin -> ORG_OWNER, ORG_ADMIN
//   workspace owner        -> ORG_ADMIN, ORG_CLINICIAN, ORG_PATIENT
//   workspace admin        -> ORG_CLINICIAN, ORG_PATIENT
// Accepting one creates a NEW account in the matching account table (User,
// Professional or OrgAdmin) and its membership together. An email that
// already has an account of that kind is refused: in Phase 1 every account
// belongs to exactly one place, so nobody's Mindora Care history is ever
// moved into an employer's workspace.

export const INVITE_TTL_DAYS = 7

export const ROLE_ACCOUNT = {
  ORG_OWNER: 'org',
  ORG_ADMIN: 'org',
  ORG_CLINICIAN: 'professional',
  ORG_PATIENT: 'user',
}

export function accountTableFor(client, role) {
  const kind = ROLE_ACCOUNT[role]
  if (kind === 'user') return client.user
  if (kind === 'professional') return client.professional
  return client.orgAdmin
}

// Whether an account of the kind this role needs already uses the email
// (any capitalisation).
export async function emailTaken(client, role, email) {
  return accountTableFor(client, role).findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  })
}

export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url')
}

// Where the invite link opens. Every portal has the /invite page, so before
// the institution portal exists (Step 7) owners and admins use the patient
// site's address.
export function inviteUrl(role, token) {
  const pick = {
    ORG_PATIENT: process.env.PATIENT_PORTAL_URL,
    ORG_CLINICIAN: process.env.PRO_PORTAL_URL,
    ORG_OWNER: process.env.ORG_PORTAL_URL || process.env.PATIENT_PORTAL_URL,
    ORG_ADMIN: process.env.ORG_PORTAL_URL || process.env.PATIENT_PORTAL_URL,
  }
  const base = (pick[role] || '').replace(/\/$/, '')
  return `${base}/invite/${token}`
}

export function inviteStatus(invite, now = new Date()) {
  if (invite.acceptedAt) return 'ACCEPTED'
  if (invite.revokedAt) return 'REVOKED'
  if (invite.expiresAt <= now) return 'EXPIRED'
  return 'PENDING'
}

// What an admin sees about an invite. Never the token or its hash.
export function inviteView(invite) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    licenceNumber: invite.licenceNumber,
    licenceExpiry: invite.licenceExpiry,
    status: inviteStatus(invite),
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    revokedAt: invite.revokedAt,
    createdAt: invite.createdAt,
  }
}

// Creates an invite and emails it. Any earlier unused invite for the same
// email in the same workspace is revoked, so only the newest link works.
// Returns { invite, url, emailed }.
export async function createInvite({ organizationId, email, role, licenceNumber, licenceExpiry, invitedByType, invitedById }) {
  const organization = await prisma.organization.findUnique({ where: { id: organizationId } })
  if (!organization) throw new HttpError(404, 'Workspace not found.')
  if (!OPEN_STATUSES.includes(organization.status)) {
    throw new HttpError(409, 'This workspace is not open, so nobody can be invited to it right now.', 'WORKSPACE_UNAVAILABLE')
  }

  const normalized = email.trim().toLowerCase()
  const existing = await emailTaken(prisma, role, normalized)
  if (existing) {
    throw new HttpError(
      409,
      'This email already has a Mindora account of this kind. In this version each account belongs to one place, so please invite a different email address.',
      'EMAIL_IN_USE'
    )
  }

  const token = newToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

  const invite = await prisma.$transaction(async (tx) => {
    await tx.organizationInvite.updateMany({
      where: { organizationId, email: normalized, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return tx.organizationInvite.create({
      data: {
        organizationId,
        email: normalized,
        role,
        tokenHash: hashInviteToken(token),
        licenceNumber: role === 'ORG_CLINICIAN' ? licenceNumber : null,
        licenceExpiry: role === 'ORG_CLINICIAN' ? licenceExpiry : null,
        invitedByType,
        invitedById,
        expiresAt,
      },
    })
  })

  const url = inviteUrl(role, token)
  let emailed = true
  try {
    await sendInviteEmail(normalized, { organizationName: organization.name, role, url, expiresAt })
  } catch (err) {
    emailed = false
    console.error('[invites] could not email an invite (the link can still be copied):', err.message)
  }
  if (process.env.EMAIL_DISABLED === 'true') emailed = false

  return { invite, url, emailed }
}

// Finds a usable invite by its token, or throws a clear reason.
export async function findUsableInvite(token, client = prisma) {
  const invite = await client.organizationInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { organization: { select: { id: true, name: true, type: true, status: true } } },
  })
  if (!invite) throw new HttpError(404, 'This invitation link is not valid.', 'INVITE_INVALID')
  const status = inviteStatus(invite)
  if (status === 'ACCEPTED') throw new HttpError(410, 'This invitation has already been used. Please sign in instead.', 'INVITE_USED')
  if (status === 'REVOKED') throw new HttpError(410, 'This invitation was withdrawn. Please ask for a new one.', 'INVITE_REVOKED')
  if (status === 'EXPIRED') throw new HttpError(410, 'This invitation has expired. Please ask for a new one.', 'INVITE_EXPIRED')
  if (!OPEN_STATUSES.includes(invite.organization.status)) {
    throw new HttpError(409, `${invite.organization.name}'s workspace is not available right now.`, 'WORKSPACE_UNAVAILABLE')
  }
  return invite
}
