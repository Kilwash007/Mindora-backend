import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { hasUsedCoveredTriage } from '../lib/sponsorship.js'

export const accountRouter = Router()

const reasonSchema = z.object({ reason: z.string().max(1000).optional() })

// Submits a deletion request — does NOT delete anything immediately. This
// is a review queue, not instant self-service deletion: see the
// AccountDeletionRequest comment in schema.prisma for why.
accountRouter.post('/deletion-request', requireAuth, requireRole('user', 'professional'), async (req, res) => {
  const parsed = reasonSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const existing = await prisma.accountDeletionRequest.findFirst({
    where: { role: req.auth.role, accountId: req.auth.id, status: 'PENDING' },
  })
  if (existing) return res.status(409).json({ error: 'You already have a pending deletion request.' })

  const account =
    req.auth.role === 'user'
      ? await prisma.user.findUnique({ where: { id: req.auth.id } })
      : await prisma.professional.findUnique({ where: { id: req.auth.id } })
  if (!account) return res.status(404).json({ error: 'Account not found.' })

  const request = await prisma.accountDeletionRequest.create({
    data: {
      role: req.auth.role,
      accountId: req.auth.id,
      email: account.email,
      reason: parsed.data.reason,
    },
  })

  await audit({
    actorType: req.auth.role,
    actorId: req.auth.id,
    action: 'account.deletion_request.create',
    resourceType: 'account_deletion_request',
    resourceId: request.id,
  })

  res.status(201).json(request)
})

accountRouter.get('/deletion-request/mine', requireAuth, requireRole('user', 'professional'), async (req, res) => {
  const request = await prisma.accountDeletionRequest.findFirst({
    where: { role: req.auth.role, accountId: req.auth.id },
    orderBy: { requestedAt: 'desc' },
  })
  res.json(request)
})

// Data-subject access request: a JSON export of everything tied to this
// account, self-serve, no admin review needed (unlike deletion).
accountRouter.get('/export', requireAuth, requireRole('user', 'professional'), async (req, res) => {
  let data

  if (req.auth.role === 'user') {
    data = await prisma.user.findUnique({
      where: { id: req.auth.id },
      select: {
        id: true,
        email: true,
        fullName: true,
        createdAt: true,
        consentAcceptedAt: true,
        consentVersion: true,
        phone: true,
        dateOfBirth: true,
        sex: true,
        county: true,
        nationalIdNumber: true,
        nextOfKinName: true,
        nextOfKinPhone: true,
        nextOfKinRelationship: true,
        checkIns: { include: { answers: true } },
        referrals: { include: { flags: true } },
        appointments: true,
        triages: {
          select: {
            id: true,
            status: true,
            isFree: true,
            urgency: true,
            careLevel: true,
            icd10Code: true,
            icd10Label: true,
            summary: true,
            creditKes: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
          },
        },
      },
    })
  } else {
    data = await prisma.professional.findUnique({
      where: { id: req.auth.id },
      select: {
        id: true,
        email: true,
        fullName: true,
        type: true,
        bio: true,
        qualifications: true,
        focusAreas: true,
        languages: true,
        yearsExperience: true,
        location: true,
        feeKes: true,
        verified: true,
        agreementAcceptedAt: true,
        agreementVersion: true,
        createdAt: true,
        appointments: true,
        documents: { select: { id: true, type: true, fileName: true, status: true, uploadedAt: true } },
      },
    })
  }

  if (!data) return res.status(404).json({ error: 'Account not found.' })

  await audit({
    actorType: req.auth.role,
    actorId: req.auth.id,
    action: 'account.export',
    resourceType: req.auth.role,
    resourceId: req.auth.id,
  })

  res.json({ exportedAt: new Date().toISOString(), data })
})

const enrollSchema = z.object({ enrollmentCode: z.string().min(1) })

// A patient links their own account to a sponsoring institution using a
// code the institution shares with them — self-service, no admin approval
// needed per-enrollment (the institution's own ACTIVE status is the gate).
// If the institution has a memberLimit (for example, 50 pilot places), new
// links are refused once it is reached; people already linked are unaffected.
accountRouter.post('/enroll', requireAuth, requireRole('user'), async (req, res) => {
  const parsed = enrollSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const institution = await prisma.institution.findUnique({
    where: { enrollmentCode: parsed.data.enrollmentCode.trim().toUpperCase() },
  })

  if (!institution || institution.status !== 'ACTIVE') {
    return res.status(404).json({ error: 'Invalid or inactive enrollment code.' })
  }

  const user = await prisma.user.findUnique({ where: { id: req.auth.id }, select: { institutionId: true } })
  const alreadyLinked = user?.institutionId === institution.id

  if (!alreadyLinked && institution.memberLimit != null) {
    const memberCount = await prisma.user.count({ where: { institutionId: institution.id } })
    if (memberCount >= institution.memberLimit) {
      return res.status(409).json({
        error:
          "All the free places in this programme have been taken. You can still complete free wellbeing check-ins and book sessions at your usual rate.",
      })
    }
  }

  if (!alreadyLinked) {
    await prisma.user.update({ where: { id: req.auth.id }, data: { institutionId: institution.id } })

    await audit({
      actorType: 'user',
      actorId: req.auth.id,
      action: 'account.institution_enroll',
      resourceType: 'institution',
      resourceId: institution.id,
    })
  }

  res.json({ name: institution.name, type: institution.type, coveragePercent: institution.coveragePercent })
})

// What the patient sees about their own linked institution — never the
// enrollment code itself (that's for re-sharing by the institution, not
// re-display to an already-linked member). Includes how many of their
// sponsored sessions they have used, when the institution sets a limit.
accountRouter.get('/institution', requireAuth, requireRole('user'), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth.id },
    include: { institution: true },
  })

  if (!user?.institution) return res.json(null)

  const sponsoredSessionsUsed = await prisma.appointment.count({
    where: {
      userId: req.auth.id,
      sponsoringInstitutionId: user.institution.id,
      status: { not: 'CANCELLED' },
    },
  })

  const triageCoveredUsed = user.institution.coversTriage ? await hasUsedCoveredTriage(req.auth.id) : false

  res.json({
    name: user.institution.name,
    type: user.institution.type,
    coveragePercent: user.institution.coveragePercent,
    status: user.institution.status,
    sponsoredSessionsPerMember: user.institution.sponsoredSessionsPerMember,
    sponsoredSessionsUsed,
    coversTriage: user.institution.coversTriage,
    triageCoveredUsed,
  })
})
