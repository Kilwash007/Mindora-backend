import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { requireOrgRole } from '../middleware/workspace.js'
import { audit } from '../lib/audit.js'
import { wrap, HttpError } from '../lib/wrap.js'
import { revokeAllSessions } from '../lib/session.js'
import { createInvite, inviteView, ROLE_ACCOUNT } from '../lib/invites.js'

// An institution's own administration of its workspace (Mindora for
// Institutions), mounted at /api/org. Owners and admins only, and always
// their own workspace (req.ctx.orgId, from the signed token): there is no
// way to name another workspace here.
//
//   GET   /me                  the workspace, member totals, and who I am
//   PATCH /settings            escalation contacts and billing email
//   GET   /invites             invitations sent from this workspace
//   POST  /invites             invite an admin (owners only), clinician or patient
//   POST  /invites/:id/revoke  withdraw an unused invitation
//   GET   /members?role=...    owners, admins or clinicians
//   PATCH /members/:id         end or restore someone's access
//
// Patients are not listed in Phase 1: an employer must not see which staff
// use the service. How far a university or provider may see its own
// patients is decided with the institution portal (Step 7).

export const orgRouter = Router()

orgRouter.use(requireAuth, requireOrgRole('ORG_OWNER', 'ORG_ADMIN'))

const contacts = z.array(z.string().trim().email()).max(5)

const settingsSchema = z
  .object({
    escalationEmails: contacts,
    escalationPhone: z.string().trim().max(30).nullable(),
    billingEmail: z.string().trim().email().nullable(),
  })
  .partial()

const inviteSchema = z
  .object({
    email: z.string().trim().email(),
    role: z.enum(['ORG_ADMIN', 'ORG_CLINICIAN', 'ORG_PATIENT']),
    licenceNumber: z.string().trim().min(3).max(60).optional(),
    licenceExpiry: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.role !== 'ORG_CLINICIAN') return
    if (!v.licenceNumber) ctx.addIssue({ code: 'custom', path: ['licenceNumber'], message: 'Enter the clinician\'s licence or registration number.' })
    if (!v.licenceExpiry) ctx.addIssue({ code: 'custom', path: ['licenceExpiry'], message: 'Enter when the licence expires.' })
    else if (new Date(`${v.licenceExpiry}T00:00:00Z`) <= new Date()) {
      ctx.addIssue({ code: 'custom', path: ['licenceExpiry'], message: 'This licence has already expired.' })
    }
  })

const memberRoleSchema = z.enum(['ORG_OWNER', 'ORG_ADMIN', 'ORG_CLINICIAN'])
const memberUpdateSchema = z.object({ active: z.boolean() })

function auditOrg(req, action, extra = {}) {
  return audit({ actorType: 'org', actorId: req.auth.id, action, organizationId: req.ctx.orgId, ...extra })
}

orgRouter.get('/me', wrap(async (req, res) => {
  const [org, me, rows] = await Promise.all([
    prisma.organization.findUnique({ where: { id: req.ctx.orgId } }),
    prisma.orgAdmin.findUnique({ where: { id: req.auth.id }, select: { id: true, fullName: true, email: true } }),
    prisma.organizationMembership.groupBy({
      by: ['role'],
      where: { organizationId: req.ctx.orgId, active: true },
      _count: { _all: true },
    }),
  ])
  if (!org) throw new HttpError(404, 'Workspace not found.')

  const members = { ORG_OWNER: 0, ORG_ADMIN: 0, ORG_CLINICIAN: 0, ORG_PATIENT: 0 }
  for (const r of rows) members[r.role] = r._count._all

  res.json({
    workspace: {
      id: org.id,
      name: org.name,
      type: org.type,
      status: org.status,
      plan: org.plan,
      escalationEmails: org.escalationEmails,
      escalationPhone: org.escalationPhone,
      billingEmail: org.billingEmail,
    },
    me: { ...me, role: req.ctx.orgRole },
    members,
  })
}))

orgRouter.patch('/settings', wrap(async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  if (Object.keys(parsed.data).length === 0) throw new HttpError(400, 'Nothing to change.')

  const org = await prisma.organization.update({ where: { id: req.ctx.orgId }, data: parsed.data })
  await auditOrg(req, 'org.settings.update', { resourceType: 'organization', resourceId: org.id, metadata: { fields: Object.keys(parsed.data) } })
  res.json({
    escalationEmails: org.escalationEmails,
    escalationPhone: org.escalationPhone,
    billingEmail: org.billingEmail,
  })
}))

orgRouter.get('/invites', wrap(async (req, res) => {
  const invites = await prisma.organizationInvite.findMany({
    where: { organizationId: req.ctx.orgId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  res.json(invites.map(inviteView))
}))

orgRouter.post('/invites', wrap(async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const d = parsed.data
  if (d.role === 'ORG_ADMIN' && req.ctx.orgRole !== 'ORG_OWNER') {
    throw new HttpError(403, 'Only an owner can invite another administrator.')
  }

  const { invite, url, emailed } = await createInvite({
    organizationId: req.ctx.orgId,
    email: d.email,
    role: d.role,
    licenceNumber: d.licenceNumber,
    licenceExpiry: d.licenceExpiry ? new Date(`${d.licenceExpiry}T00:00:00Z`) : undefined,
    invitedByType: 'org',
    invitedById: req.auth.id,
  })
  await auditOrg(req, 'org.invite.create', { resourceType: 'organization_invite', resourceId: invite.id, metadata: { role: invite.role } })
  res.status(201).json({ ...inviteView(invite), url, emailed })
}))

orgRouter.post('/invites/:id/revoke', wrap(async (req, res) => {
  const revoked = await prisma.organizationInvite.updateMany({
    where: {
      id: req.params.id,
      organizationId: req.ctx.orgId,
      acceptedAt: null,
      revokedAt: null,
      ...(req.ctx.orgRole === 'ORG_OWNER' ? {} : { role: { in: ['ORG_CLINICIAN', 'ORG_PATIENT'] } }),
    },
    data: { revokedAt: new Date() },
  })
  if (revoked.count === 0) throw new HttpError(404, 'No open invitation to withdraw.')
  await auditOrg(req, 'org.invite.revoke', { resourceType: 'organization_invite', resourceId: req.params.id })
  res.json({ id: req.params.id, status: 'REVOKED' })
}))

orgRouter.get('/members', wrap(async (req, res) => {
  const role = memberRoleSchema.safeParse(req.query.role)
  if (!role.success) throw new HttpError(400, 'Choose role=ORG_CLINICIAN, ORG_ADMIN or ORG_OWNER.')

  const memberships = await prisma.organizationMembership.findMany({
    where: { organizationId: req.ctx.orgId, role: role.data },
    orderBy: { createdAt: 'asc' },
    include: {
      professional: { select: { fullName: true, email: true, type: true, onCallForTriage: true, agreementAcceptedAt: true } },
      orgAdmin: { select: { fullName: true, email: true } },
    },
  })

  res.json(
    memberships.map((m) => {
      const person = m.professional ?? m.orgAdmin
      return {
        membershipId: m.id,
        role: m.role,
        active: m.active,
        fullName: person?.fullName ?? null,
        email: person?.email ?? null,
        joinedAt: m.createdAt,
        ...(m.role === 'ORG_CLINICIAN'
          ? {
              type: m.professional?.type ?? null,
              licenceNumber: m.licenceNumber,
              licenceExpiry: m.licenceExpiry,
              onCall: Boolean(m.professional?.onCallForTriage),
              agreementAccepted: Boolean(m.professional?.agreementAcceptedAt),
            }
          : {}),
      }
    })
  )
}))

// Ending someone's access signs them out everywhere straight away; their
// records stay in the workspace. Restoring it lets them sign in again.
orgRouter.patch('/members/:id', wrap(async (req, res) => {
  const parsed = memberUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const m = await prisma.organizationMembership.findFirst({ where: { id: req.params.id, organizationId: req.ctx.orgId } })
  if (!m) throw new HttpError(404, 'Member not found.')
  if (m.orgAdminId && m.orgAdminId === req.auth.id) throw new HttpError(400, 'You cannot change your own access.')
  if ((m.role === 'ORG_OWNER' || m.role === 'ORG_ADMIN') && req.ctx.orgRole !== 'ORG_OWNER') {
    throw new HttpError(403, 'Only an owner can change an administrator\'s access.')
  }
  if (m.role === 'ORG_OWNER' && !parsed.data.active) {
    const owners = await prisma.organizationMembership.count({
      where: { organizationId: req.ctx.orgId, role: 'ORG_OWNER', active: true },
    })
    if (owners <= 1) throw new HttpError(409, 'A workspace must keep at least one active owner.')
  }

  const updated = await prisma.organizationMembership.update({ where: { id: m.id }, data: { active: parsed.data.active } })
  if (!parsed.data.active) {
    const accountId = m.userId ?? m.professionalId ?? m.orgAdminId
    await revokeAllSessions(ROLE_ACCOUNT[m.role], accountId)
  }
  await auditOrg(req, parsed.data.active ? 'org.member.restore' : 'org.member.end', {
    resourceType: 'organization_membership',
    resourceId: m.id,
    metadata: { role: m.role },
  })
  res.json({ membershipId: updated.id, active: updated.active })
}))
