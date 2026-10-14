import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { CURRENT_AGREEMENT_VERSION } from '../lib/agreement.js'
import { STUDENT_RATE_FEE_CAP_KES } from '../lib/pricing.js'
import { PROFESSIONAL_TYPES } from '../lib/professionalTypes.js'

export const professionalRouter = Router()

// Any authenticated person (user or professional) can browse the directory.
// Only verified professionals are ever listed publicly. When the requester
// is a Student Rate-eligible patient, professionals who've opted into the
// tier (studentRateFeeKes set) and are less experienced/junior
// (yearsExperience < 3 — the practical stand-in for "freelance," since
// Mindora doesn't track employment type as its own concept) are sorted
// first. This is a soft preference, not a filter — every verified
// professional still appears, eligible or not.
professionalRouter.get('/', requireAuth, async (req, res) => {
  const professionals = await prisma.professional.findMany({
    where: { verified: true },
    orderBy: { createdAt: 'asc' },
  })

  let studentRateEligible = false
  if (req.auth.role === 'user') {
    const user = await prisma.user.findUnique({ where: { id: req.auth.id }, select: { studentRateEligible: true } })
    studentRateEligible = user?.studentRateEligible ?? false
  }

  if (!studentRateEligible) return res.json(professionals)

  const sorted = [...professionals].sort((a, b) => {
    const aPriority = a.studentRateFeeKes != null && a.yearsExperience < 3
    const bPriority = b.studentRateFeeKes != null && b.yearsExperience < 3
    if (aPriority === bPriority) return 0
    return aPriority ? -1 : 1
  })
  res.json(sorted)
})

// Agreement status — placed before '/:id' would also be fine here since
// this is a two-segment path, but kept early for readability.
professionalRouter.get(
  '/agreement/status',
  requireAuth,
  requireRole('professional'),
  async (req, res) => {
    const professional = await prisma.professional.findUnique({ where: { id: req.auth.id } })
    if (!professional) return res.status(401).json({ error: 'Authentication required.' })

    res.json({
      accepted:
        professional.agreementAcceptedAt !== null &&
        professional.agreementVersion === CURRENT_AGREEMENT_VERSION,
      acceptedAt: professional.agreementAcceptedAt,
      acceptedVersion: professional.agreementVersion,
      currentVersion: CURRENT_AGREEMENT_VERSION,
    })
  }
)

professionalRouter.post(
  '/agreement/accept',
  requireAuth,
  requireRole('professional'),
  async (req, res) => {
    const updated = await prisma.professional.update({
      where: { id: req.auth.id },
      data: { agreementAcceptedAt: new Date(), agreementVersion: CURRENT_AGREEMENT_VERSION },
    })

    await audit({
      actorType: 'professional',
      actorId: req.auth.id,
      action: 'agreement.accept',
      resourceType: 'professional',
      resourceId: req.auth.id,
      metadata: { version: CURRENT_AGREEMENT_VERSION },
    })

    res.json({
      accepted: true,
      acceptedAt: updated.agreementAcceptedAt,
      acceptedVersion: updated.agreementVersion,
    })
  }
)

// --- Self-profile view/edit ---
// '/me/profile' is a two-segment path, so it never conflicts with the
// single-segment '/:id' route below regardless of declaration order.

const updateProfileSchema = z.object({
  type: z.enum(PROFESSIONAL_TYPES).optional(),
  bio: z.string().max(2000).optional(),
  qualifications: z.array(z.string()).optional(),
  focusAreas: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  yearsExperience: z.number().int().min(0).max(70).optional(),
  location: z.string().optional(),
  feeKes: z.number().int().min(0).optional(),
  // null explicitly opts back out of the Student Rate tier; omitting the
  // field leaves it unchanged, same convention as every other optional
  // field here.
  studentRateFeeKes: z.number().int().min(1).max(STUDENT_RATE_FEE_CAP_KES).nullable().optional(),
  supervisorName: z.string().max(200).nullable().optional(),
  onlineAvailable: z.boolean().optional(),
  inPersonAvailable: z.boolean().optional(),
})

// A professional's own full profile — unlike the public directory (which
// only ever shows verified professionals), this returns their own record
// regardless of verification status, since they need to see and edit it
// before they're approved.
professionalRouter.get('/me/profile', requireAuth, requireRole('professional'), async (req, res) => {
  const professional = await prisma.professional.findUnique({ where: { id: req.auth.id } })
  if (!professional) return res.status(401).json({ error: 'Authentication required.' })
  res.json(professional)
})

professionalRouter.patch('/me/profile', requireAuth, requireRole('professional'), async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const current = await prisma.professional.findUnique({ where: { id: req.auth.id } })
  if (!current) return res.status(401).json({ error: 'Authentication required.' })

  // Qualifications and professional type are the claims the "Verified by
  // Mindora" badge actually vouches for — they're what the reviewed KYC
  // documents (degree certificate, license) substantiate. Changing either
  // after verification without re-review would let a claim go unchecked
  // while the verified badge kept showing, so any real change automatically
  // un-verifies the account until admin reviews it again.
  const data = { ...parsed.data }
  let credentialsChanged = false

  if (parsed.data.qualifications) {
    const changed =
      JSON.stringify(parsed.data.qualifications) !== JSON.stringify(current.qualifications)
    if (changed && current.verified) {
      data.verified = false
      credentialsChanged = true
    }
  }

  if (parsed.data.type && parsed.data.type !== current.type && current.verified) {
    data.verified = false
    credentialsChanged = true
  }

  const updated = await prisma.professional.update({
    where: { id: req.auth.id },
    data,
  })

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: credentialsChanged ? 'professional.credentials_changed' : 'professional.profile_update',
    resourceType: 'professional',
    resourceId: req.auth.id,
  })

  res.json(updated)
})

professionalRouter.get('/:id', requireAuth, async (req, res) => {
  const professional = await prisma.professional.findUnique({
    where: { id: req.params.id },
  })
  if (!professional || !professional.verified) {
    return res.status(404).json({ error: 'Professional not found.' })
  }
  res.json(professional)
})