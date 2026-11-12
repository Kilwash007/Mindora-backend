import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireAdminRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { wrap, HttpError } from '../lib/wrap.js'
import { createInvite, inviteView } from '../lib/invites.js'

// Mindora's own view of institution workspaces (Mindora for Institutions),
// mounted at /api/admin/organizations. PLATFORM_ADMIN only.
//
// Mindora creates a workspace, sets its type, plan and status, and invites
// its first owner. After that the institution runs its own people through
// /api/org. Mindora sees TOTALS here (how many owners, admins, clinicians and
// patients), never the institution's clinicians, patients or records. The
// only people Mindora sees by email are the owners and admins it invited.

export const organizationAdminRouter = Router()

organizationAdminRouter.use(requireAuth, requireAdminRole('PLATFORM_ADMIN'))

const ORG_TYPES = ['PROVIDER', 'NGO', 'UNIVERSITY', 'EMPLOYER', 'INSURER']
const ORG_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED']
// pilot: trying it out; standard: paying; demo: Mindora's own demo
// workspace, left out of usage and invoices (Step 9).
const ORG_PLANS = ['pilot', 'standard', 'demo']

const contacts = z.array(z.string().trim().email()).max(5)

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(ORG_TYPES),
  plan: z.enum(ORG_PLANS).default('pilot'),
  status: z.enum(['TRIAL', 'ACTIVE']).default('TRIAL'),
  escalationEmails: contacts.default([]),
  escalationPhone: z.string().trim().max(30).optional(),
  billingEmail: z.string().trim().email().optional(),
})

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    type: z.enum(ORG_TYPES),
    plan: z.enum(ORG_PLANS),
    status: z.enum(ORG_STATUSES),
    escalationEmails: contacts,
    escalationPhone: z.string().trim().max(30).nullable(),
    billingEmail: z.string().trim().email().nullable(),
  })
  .partial()

const inviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['ORG_OWNER', 'ORG_ADMIN']),
})

// Members per role, active only: { ORG_OWNER: 1, ORG_CLINICIAN: 4, ... }
async function memberCounts(organizationIds) {
  const rows = await prisma.organizationMembership.groupBy({
    by: ['organizationId', 'role'],
    where: { organizationId: { in: organizationIds }, active: true },
    _count: { _all: true },
  })
  const byOrg = new Map()
  for (const r of rows) {
    const counts = byOrg.get(r.organizationId) ?? { ORG_OWNER: 0, ORG_ADMIN: 0, ORG_CLINICIAN: 0, ORG_PATIENT: 0 }
    counts[r.role] = r._count._all
    byOrg.set(r.organizationId, counts)
  }
  return byOrg
}

function orgView(org, counts) {
  return {
    id: org.id,
    name: org.name,
    type: org.type,
    status: org.status,
    plan: org.plan,
    escalationEmails: org.escalationEmails,
    escalationPhone: org.escalationPhone,
    billingEmail: org.billingEmail,
    createdAt: org.createdAt,
    members: counts ?? { ORG_OWNER: 0, ORG_ADMIN: 0, ORG_CLINICIAN: 0, ORG_PATIENT: 0 },
  }
}

organizationAdminRouter.get('/', wrap(async (req, res) => {
  const orgs = await prisma.organization.findMany({ orderBy: { createdAt: 'desc' } })
  const counts = await memberCounts(orgs.map((o) => o.id))
  await audit({ actorType: 'admin', actorId: req.auth.id, action: 'admin.organizations.list', resourceType: 'organization' })
  res.json(orgs.map((o) => orgView(o, counts.get(o.id))))
}))

organizationAdminRouter.post('/', wrap(async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const org = await prisma.organization.create({ data: parsed.data })
  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'organization.create',
    resourceType: 'organization',
    resourceId: org.id,
    metadata: { type: org.type, plan: org.plan },
  })
  res.status(201).json(orgView(org))
}))

async function loadOrg(id) {
  const org = await prisma.organization.findUnique({ where: { id } })
  if (!org) throw new HttpError(404, 'Workspace not found.')
  return org
}

// One workspace: its settings, member totals, and the owner and admin
// invitations (the only people Mindora sees by email).
organizationAdminRouter.get('/:id', wrap(async (req, res) => {
  const org = await loadOrg(req.params.id)
  const counts = await memberCounts([org.id])
  const invites = await prisma.organizationInvite.findMany({
    where: { organizationId: org.id, role: { in: ['ORG_OWNER', 'ORG_ADMIN'] } },
    orderBy: { createdAt: 'desc' },
  })
  await audit({ actorType: 'admin', actorId: req.auth.id, action: 'organization.view', resourceType: 'organization', resourceId: org.id })
  res.json({ ...orgView(org, counts.get(org.id)), invites: invites.map(inviteView) })
}))

organizationAdminRouter.patch('/:id', wrap(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  if (Object.keys(parsed.data).length === 0) throw new HttpError(400, 'Nothing to change.')

  const org = await loadOrg(req.params.id)
  const updated = await prisma.organization.update({ where: { id: org.id }, data: parsed.data })
  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'organization.update',
    resourceType: 'organization',
    resourceId: org.id,
    metadata: { fields: Object.keys(parsed.data), status: parsed.data.status, plan: parsed.data.plan },
  })
  const counts = await memberCounts([org.id])
  res.json(orgView(updated, counts.get(org.id)))
}))

// Invite an owner or admin. The answer carries the link once, so it can be
// copied and sent another way; it is never shown again.
organizationAdminRouter.post('/:id/invites', wrap(async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const org = await loadOrg(req.params.id)
  const { invite, url, emailed } = await createInvite({
    organizationId: org.id,
    email: parsed.data.email,
    role: parsed.data.role,
    invitedByType: 'admin',
    invitedById: req.auth.id,
  })
  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'organization.invite.create',
    resourceType: 'organization_invite',
    resourceId: invite.id,
    metadata: { role: invite.role },
    organizationId: org.id,
  })
  res.status(201).json({ ...inviteView(invite), url, emailed })
}))

organizationAdminRouter.post('/:id/invites/:inviteId/revoke', wrap(async (req, res) => {
  const org = await loadOrg(req.params.id)
  const revoked = await prisma.organizationInvite.updateMany({
    where: {
      id: req.params.inviteId,
      organizationId: org.id,
      role: { in: ['ORG_OWNER', 'ORG_ADMIN'] },
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  })
  if (revoked.count === 0) throw new HttpError(404, 'No open invitation to withdraw.')
  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'organization.invite.revoke',
    resourceType: 'organization_invite',
    resourceId: req.params.inviteId,
    organizationId: org.id,
  })
  res.json({ id: req.params.inviteId, status: 'REVOKED' })
}))
