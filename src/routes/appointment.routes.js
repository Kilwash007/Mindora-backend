import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole, requireAgreement } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { calculatePlatformFeeKes } from '../lib/pricing.js'
import { PUBLIC_PROFESSIONAL_SELECT } from '../lib/safeSelects.js'

export const appointmentRouter = Router()

// Fixed session length — matches the industry-standard "60 min" sessions
// seen across comparable Kenyan platforms. A real per-professional
// availability calendar (with configurable slot lengths) is the natural
// next step beyond this; this is the minimum fix for the actual bug:
// nothing currently stops two patients booking the same professional at
// the same time.
const SESSION_DURATION_MINUTES = 60

const bookSchema = z.object({
  professionalId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
  type: z.enum(['ONLINE', 'IN_PERSON']),
})

// Patient booking — not gated by the professional agreement, since the
// patient isn't the one bound by it.
appointmentRouter.post('/', requireAuth, requireRole('user'), async (req, res) => {
  const parsed = bookSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { professionalId, scheduledFor, type } = parsed.data
  const requestedTime = new Date(scheduledFor)

  if (requestedTime < new Date()) {
    return res.status(400).json({ error: 'Appointment time must be in the future.' })
  }

  const professional = await prisma.professional.findUnique({ where: { id: professionalId } })
  if (!professional || !professional.verified) {
    return res.status(404).json({ error: 'Professional not found.' })
  }

  // Conflict check: with a fixed session length, two appointments for the
  // same professional overlap whenever their start times fall within one
  // session length of each other. Cancelled appointments free up the slot.
  const windowStart = new Date(requestedTime.getTime() - SESSION_DURATION_MINUTES * 60 * 1000)
  const windowEnd = new Date(requestedTime.getTime() + SESSION_DURATION_MINUTES * 60 * 1000)

  const conflict = await prisma.appointment.findFirst({
    where: {
      professionalId,
      status: { not: 'CANCELLED' },
      scheduledFor: { gt: windowStart, lt: windowEnd },
    },
  })

  if (conflict) {
    return res.status(409).json({
      error: 'This professional already has an appointment around that time. Please choose a different slot.',
    })
  }

  const user = await prisma.user.findUnique({ where: { id: req.auth.id }, include: { institution: true } })
  const institution = user?.institution

  // A patient linked to an ACTIVE university through its enrollment code
  // is treated as a verified student for the Student Rate — the university
  // code is itself the proof of student status, so no separate Student
  // Rate verification is needed.
  const isUniversityMember = Boolean(
    institution && institution.type === 'UNIVERSITY' && institution.status === 'ACTIVE'
  )
  const studentRateEligible = Boolean(user?.studentRateEligible || isUniversityMember)

  // Sponsorship applies only when the patient's institution is ACTIVE, has
  // coverage, and — if it sets sponsoredSessionsPerMember (for example, 2
  // free pilot sessions) — the patient hasn't used them all yet. Cancelled
  // sessions don't count against the limit; completed and no-show ones do.
  let sponsorshipAvailable = false
  if (institution && institution.status === 'ACTIVE' && institution.coveragePercent > 0) {
    if (institution.sponsoredSessionsPerMember == null) {
      sponsorshipAvailable = true
    } else {
      const used = await prisma.appointment.count({
        where: {
          userId: req.auth.id,
          sponsoringInstitutionId: institution.id,
          status: { not: 'CANCELLED' },
        },
      })
      sponsorshipAvailable = used < institution.sponsoredSessionsPerMember
    }
  }

  // Student Rate takes priority over a listed full fee, but defers to an
  // available institution sponsorship — stacking both would be confusing to
  // reconcile. Once a member's sponsored sessions are used up, they fall
  // back to the Student Rate (verified students and university members) or
  // the standard fee.
  const useStudentRate =
    !sponsorshipAvailable && studentRateEligible && professional.studentRateFeeKes != null

  // University sponsorships (such as a Mindora-funded campus pilot) are
  // priced at the professional's Student Rate fee when they have one, so
  // sponsored student sessions stay at the student rate rather than the
  // professional's standard fee.
  const universityStudentRate =
    sponsorshipAvailable && institution.type === 'UNIVERSITY' && professional.studentRateFeeKes != null

  // Any session priced at the Student Rate fee — whether the student pays
  // it themselves or a university covers it — uses the Student Rate
  // commission (25%), so professionals are paid consistently for every
  // student session.
  const studentRatePricing = Boolean(useStudentRate || universityStudentRate)

  const fullFee = studentRatePricing ? professional.studentRateFeeKes : professional.feeKes ?? 0

  let sponsoringInstitutionId = null
  let institutionCoveredKes = 0
  let institutionType = null

  if (sponsorshipAvailable) {
    sponsoringInstitutionId = institution.id
    institutionType = institution.type
    institutionCoveredKes = Math.min(fullFee, Math.round((fullFee * institution.coveragePercent) / 100))
  }

  // Platform commission: 35% standard, 25% on any Student Rate-priced
  // session, and 0% on corporate/EAP sponsorships. See src/lib/pricing.js.
  const platformFeeKes = calculatePlatformFeeKes(fullFee, institutionType, studentRatePricing)

  const appointment = await prisma.appointment.create({
    data: {
      userId: req.auth.id,
      professionalId,
      scheduledFor: requestedTime,
      type,
      feeKes: fullFee,
      platformFeeKes,
      isStudentRateBooking: studentRatePricing,
      sponsoringInstitutionId,
      institutionCoveredKes,
    },
  })

  let finalAppointment = appointment
  if (type === 'ONLINE') {
    finalAppointment = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { meetingUrl: `https://meet.jit.si/mindora-${appointment.id}` },
    })
  }

  await audit({
    actorType: 'user',
    actorId: req.auth.id,
    action: 'appointment.book',
    resourceType: 'appointment',
    resourceId: appointment.id,
    metadata: {
      platformFeeKes,
      isStudentRateBooking: studentRatePricing,
      ...(sponsoringInstitutionId ? { institutionCoveredKes } : {}),
    },
  })

  res.status(201).json(finalAppointment)
})

const statusSchema = z.object({
  status: z.enum(['COMPLETED', 'CANCELLED', 'NO_SHOW']),
})

appointmentRouter.patch(
  '/:id/status',
  requireAuth,
  requireRole('professional'),
  requireAgreement,
  async (req, res) => {
    const parsed = statusSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id } })
    if (!appointment || appointment.professionalId !== req.auth.id) {
      return res.status(404).json({ error: 'Appointment not found.' })
    }

    const updated = await prisma.appointment.update({
      where: { id: req.params.id },
      data: { status: parsed.data.status },
    })

    await audit({
      actorType: 'professional',
      actorId: req.auth.id,
      action: 'appointment.status_update',
      resourceType: 'appointment',
      resourceId: appointment.id,
      metadata: { status: parsed.data.status },
    })

    res.json(updated)
  }
)

// Patient's own appointments — not gated by the professional agreement.
// The professional comes back with public fields only.
appointmentRouter.get('/mine', requireAuth, requireRole('user'), async (req, res) => {
  const appointments = await prisma.appointment.findMany({
    where: { userId: req.auth.id },
    include: { professional: { select: PUBLIC_PROFESSIONAL_SELECT } },
    orderBy: { scheduledFor: 'desc' },
  })
  res.json(appointments)
})

appointmentRouter.get('/', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const appointments = await prisma.appointment.findMany({
    where: { professionalId: req.auth.id },
    orderBy: { scheduledFor: 'asc' },
  })

  const now = new Date()
  res.json({
    upcoming: appointments.filter((a) => a.scheduledFor >= now),
    past: appointments.filter((a) => a.scheduledFor < now),
  })
})
