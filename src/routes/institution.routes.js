import { Router } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireAdminRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'

export const institutionRouter = Router()

// Institutions are business/compliance-sensitive partner records —
// PLATFORM_ADMIN only, same tier as Analytics and professional verification.

function generateEnrollmentCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase() // e.g. "A1B2C3D4"
}

// Pilot limits: null (or omitted) means unlimited.
const limitField = z.number().int().min(1).nullable().optional()

const createSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['EMPLOYER', 'UNIVERSITY', 'HEALTHCARE_PROVIDER', 'INSURER', 'OTHER']),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  notes: z.string().optional(),
  coveragePercent: z.number().int().min(0).max(100).optional(),
  memberLimit: limitField,
  sponsoredSessionsPerMember: limitField,
  coversTriage: z.boolean().optional(),
})

institutionRouter.get('/', requireAuth, requireAdminRole('PLATFORM_ADMIN'), async (req, res) => {
  const institutions = await prisma.institution.findMany({ orderBy: { createdAt: 'desc' } })

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'admin.institutions.list',
    resourceType: 'institution',
  })

  res.json(institutions)
})

institutionRouter.post('/', requireAuth, requireAdminRole('PLATFORM_ADMIN'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const institution = await prisma.institution.create({
    data: { ...parsed.data, enrollmentCode: generateEnrollmentCode() },
  })

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'institution.create',
    resourceType: 'institution',
    resourceId: institution.id,
  })

  res.status(201).json(institution)
})

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(['EMPLOYER', 'UNIVERSITY', 'HEALTHCARE_PROVIDER', 'INSURER', 'OTHER']).optional(),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'INACTIVE']).optional(),
  notes: z.string().optional(),
  coveragePercent: z.number().int().min(0).max(100).optional(),
  memberLimit: limitField,
  sponsoredSessionsPerMember: limitField,
  coversTriage: z.boolean().optional(),
})

institutionRouter.patch('/:id', requireAuth, requireAdminRole('PLATFORM_ADMIN'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const institution = await prisma.institution.findUnique({ where: { id: req.params.id } })
  if (!institution) return res.status(404).json({ error: 'Institution not found.' })

  const updated = await prisma.institution.update({
    where: { id: req.params.id },
    data: parsed.data,
  })

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'institution.update',
    resourceType: 'institution',
    resourceId: institution.id,
    metadata: parsed.data,
  })

  res.json(updated)
})

// Aggregate usage stats only — deliberately never returns which specific
// patients are linked, matching how real Employee Assistance Programs
// guarantee anonymity to covered employees. An institution sees counts and
// totals for billing purposes, never a list of who used the benefit.
institutionRouter.get('/:id/stats', requireAuth, requireAdminRole('PLATFORM_ADMIN'), async (req, res) => {
  const institution = await prisma.institution.findUnique({ where: { id: req.params.id } })
  if (!institution) return res.status(404).json({ error: 'Institution not found.' })

  const [memberCount, sponsoredAppointmentCount, coverageSum] = await Promise.all([
    prisma.user.count({ where: { institutionId: institution.id } }),
    prisma.appointment.count({
      where: { sponsoringInstitutionId: institution.id, status: { not: 'CANCELLED' } },
    }),
    prisma.appointment.aggregate({
      where: { sponsoringInstitutionId: institution.id, status: { not: 'CANCELLED' } },
      _sum: { institutionCoveredKes: true },
    }),
  ])

  const sponsoredTriageCount = await prisma.triage.count({
    where: { sponsoringInstitutionId: institution.id, status: { not: 'CANCELLED' } },
  })

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'institution.stats.view',
    resourceType: 'institution',
    resourceId: institution.id,
  })

  res.json({
    memberCount,
    memberLimit: institution.memberLimit,
    placesRemaining:
      institution.memberLimit == null ? null : Math.max(0, institution.memberLimit - memberCount),
    sponsoredSessionsPerMember: institution.sponsoredSessionsPerMember,
    sponsoredAppointmentCount,
    sponsoredTriageCount,
    coversTriage: institution.coversTriage,
    totalCoveredKes: coverageSum._sum.institutionCoveredKes ?? 0,
  })
})