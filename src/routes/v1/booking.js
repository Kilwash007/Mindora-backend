import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { db } from '../../lib/db.js'
import { professionalScope } from '../../lib/workspace.js'
import { requireAuth, requireRole } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { wrap, HttpError } from '../../lib/wrap.js'
import { commissionApplies } from '../../lib/pricing.js'
import {
  PAYOUT_ON_FULL_PRICE,
  SERVICE_LABELS,
  getPriceRow,
  priceFor,
  isStudentEligible,
  professionalPayoutKes,
} from '../../lib/priceList.js'
import { CARE_LEVEL_SERVICE, SERVICE_PROFESSIONAL_TYPES } from '../../lib/triage.js'
import { holdExpiresAt } from '../../lib/holds.js'

export const bookingRouter = Router()

// Same fixed session length as the original booking route.
const SESSION_DURATION_MINUTES = 60

// Works out what a patient may book, and for how much, from their latest
// COMPLETED triage. Everything is computed here on the server.
//
// Workspaces: the triage and earlier sessions are read through db(ctx), and
// the institution covers the whole session (see the POST route below).
async function computeBookingTerms(ctx, userId) {
  const triage = await db(ctx).triage.findFirst({
    where: { userId, status: 'COMPLETED', careLevel: { not: null } },
    orderBy: { completedAt: 'desc' },
    include: { creditAppointment: { select: { status: true } } },
  })
  if (!triage) {
    throw new HttpError(409, 'Please complete a screening and triage before booking a session.', 'TRIAGE_REQUIRED')
  }
  if (triage.careLevel === 'EMERGENCY_REFERRAL') {
    throw new HttpError(
      409,
      'Your triage recommended emergency care. Please contact emergency services, or the clinician who reviewed you.',
      'EMERGENCY_REFERRAL'
    )
  }

  let service = CARE_LEVEL_SERVICE[triage.careLevel]
  if (triage.careLevel === 'PSYCHIATRY') {
    const priorInitial = await db(ctx).appointment.findFirst({
      where: { userId, serviceType: 'PSYCHIATRY_INITIAL', status: 'COMPLETED' },
      select: { id: true },
    })
    if (priorInitial) service = 'PSYCHIATRY_FOLLOWUP'
  }

  const row = await getPriceRow(service)
  if (!row || !row.active) {
    throw new HttpError(503, 'This service is not available right now.', 'SERVICE_UNAVAILABLE')
  }

  // Student Rate is a Mindora Care tier only.
  const isStudent = ctx.orgId ? false : await isStudentEligible(userId)
  const listPriceKes = priceFor(row, { isStudent })
  const studentPriceApplied = isStudent && row.studentPriceKes != null

  // The triage credit is used once, on the first session booked after
  // triage. If that session is cancelled, the credit is available again.
  const creditAvailable =
    triage.creditKes > 0 && (!triage.creditAppointmentId || triage.creditAppointment?.status === 'CANCELLED')
  const triageCreditKes = creditAvailable ? Math.min(triage.creditKes, listPriceKes) : 0

  return {
    triageId: triage.id,
    careLevel: triage.careLevel,
    service,
    serviceLabel: SERVICE_LABELS[service],
    payoutPercent: row.payoutPercent,
    listPriceKes,
    studentPriceApplied,
    triageCreditKes,
    balanceKes: listPriceKes - triageCreditKes,
    professionalTypes: SERVICE_PROFESSIONAL_TYPES[service],
  }
}

// What the patient can book, the price, and the credit, before they choose
// a professional. The app uses the public directory filtered by professionalTypes.
bookingRouter.get('/options', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const t = await computeBookingTerms(req.ctx, req.auth.id)
  res.json({ eligible: true, ...t })
}))

const bookSchema = z.object({
  professionalId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
  type: z.enum(['ONLINE', 'IN_PERSON']),
})

bookingRouter.post('/', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const parsed = bookSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { professionalId, scheduledFor, type } = parsed.data
  const userId = req.auth.id
  const requestedTime = new Date(scheduledFor)
  if (requestedTime < new Date()) throw new HttpError(400, 'Appointment time must be in the future.')

  const terms = await computeBookingTerms(req.ctx, userId)
  const inWorkspace = Boolean(req.ctx.orgId)

  // Only a professional in the patient's own scope can be booked: a
  // workspace's own clinicians, or Mindora Care's professionals.
  const professional = await prisma.professional.findFirst({
    where: { id: professionalId, verified: true, deletedAt: null, ...professionalScope(req.ctx.orgId) },
  })
  if (!professional) throw new HttpError(404, 'Professional not found.')
  if (!terms.professionalTypes.includes(professional.type)) {
    throw new HttpError(400, `This professional does not provide ${terms.serviceLabel}. Please choose another.`, 'WRONG_PROFESSIONAL_TYPE')
  }
  if (type === 'ONLINE' && !professional.onlineAvailable) {
    throw new HttpError(400, 'This professional does not offer online sessions.')
  }
  if (type === 'IN_PERSON' && !professional.inPersonAvailable) {
    throw new HttpError(400, 'This professional does not offer in-person sessions.')
  }

  // Overlap check: with a fixed session length, two appointments for the
  // same professional overlap when their start times are within one
  // session length of each other. Cancelled appointments free the slot.
  const windowStart = new Date(requestedTime.getTime() - SESSION_DURATION_MINUTES * 60 * 1000)
  const windowEnd = new Date(requestedTime.getTime() + SESSION_DURATION_MINUTES * 60 * 1000)
  // Checked across every scope: a clinician's calendar is one calendar.
  const conflict = await prisma.appointment.findFirst({
    where: {
      professionalId,
      status: { not: 'CANCELLED' },
      scheduledFor: { gt: windowStart, lt: windowEnd },
    },
  })
  if (conflict) {
    throw new HttpError(409, 'This professional already has an appointment around that time. Please choose a different slot.', 'SLOT_TAKEN')
  }

  // Institution sponsorship, as before: only an ACTIVE institution with
  // coverage, and only while the member has sponsored sessions left. Here
  // the coverage applies to the balance AFTER the triage credit.
  // (Mindora Care programmes only. A workspace is covered below instead.)
  const user = inWorkspace ? null : await prisma.user.findUnique({ where: { id: userId }, include: { institution: true } })
  const institution = user?.institution
  let sponsorshipAvailable = false
  // A programme that asks for student proof only covers people whose proof is approved.
  const proofOk = !institution?.requiresStudentProof || Boolean(user?.studentRateEligible)
  if (institution && institution.status === 'ACTIVE' && institution.coveragePercent > 0 && proofOk) {
    if (institution.sponsoredSessionsPerMember == null) {
      sponsorshipAvailable = true
    } else {
      const used = await prisma.appointment.count({
        where: { userId, sponsoringInstitutionId: institution.id, status: { not: 'CANCELLED' } },
      })
      sponsorshipAvailable = used < institution.sponsoredSessionsPerMember
    }
  }

  const feeKes = terms.balanceKes
  // A workspace session is covered in full by the institution (it is billed
  // through monthly usage), so the patient never gets an M-Pesa prompt.
  const institutionCoveredKes = inWorkspace
    ? feeKes
    : sponsorshipAvailable
      ? Math.min(feeKes, Math.round((feeKes * institution.coveragePercent) / 100))
      : 0
  const amountDueKes = feeKes - institutionCoveredKes

  // Professional payout. Corporate/EAP sponsorships keep the existing
  // exemption (no platform commission, Mindora earns a retainer instead).
  // Everything else pays the professional their percentage of the price.
  // A workspace's clinicians are paid by their institution, not by Mindora,
  // so no platform fee is recorded on the session.
  const commissionExempt = inWorkspace || (sponsorshipAvailable && !commissionApplies(institution.type))
  const payoutKes = commissionExempt
    ? feeKes
    : professionalPayoutKes(PAYOUT_ON_FULL_PRICE ? terms.listPriceKes : feeKes, terms.payoutPercent)
  const platformFeeKes = Math.max(0, feeKes - payoutKes)

  let appointment
  try {
    appointment = await db(req.ctx).$transaction(async (tx) => {
      const created = await tx.appointment.create({
        data: {
          userId,
          professionalId,
          scheduledFor: requestedTime,
          type,
          feeKes,
          platformFeeKes,
          isStudentRateBooking: terms.studentPriceApplied,
          serviceType: terms.service,
          listPriceKes: terms.listPriceKes,
          triageCreditKes: terms.triageCreditKes,
          triageId: terms.triageId,
          sponsoringInstitutionId: sponsorshipAvailable ? institution.id : null,
          institutionCoveredKes,
          // The video link is added when the balance is paid (or right now
          // when nothing is left to pay), so an unpaid booking has no link.
          meetingUrl: null,
        },
      })

      if (terms.triageCreditKes > 0) {
        const claimed = await tx.triage.updateMany({
          where: {
            id: terms.triageId,
            creditKes: { gt: 0 },
            OR: [{ creditAppointmentId: null }, { creditAppointment: { status: 'CANCELLED' } }],
          },
          data: { creditAppointmentId: created.id },
        })
        if (claimed.count === 0) {
          throw new HttpError(409, 'Your triage credit was just used on another booking. Please try again.', 'CREDIT_USED')
        }
      }

      if (type === 'ONLINE' && amountDueKes === 0) {
        return tx.appointment.update({
          where: { id: created.id },
          data: { meetingUrl: `https://meet.jit.si/mindora-${created.id}` },
        })
      }
      return created
    })
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw err
  }

  await audit({
    actorType: 'user',
    actorId: userId,
    action: 'appointment.book',
    resourceType: 'appointment',
    resourceId: appointment.id,
    metadata: {
      service: terms.service,
      listPriceKes: terms.listPriceKes,
      triageCreditKes: terms.triageCreditKes,
      amountDueKes,
      platformFeeKes,
    },
    organizationId: req.ctx.orgId,
  })

  // Pay the balance with POST /api/payments/initiate { appointmentId, phoneNumber }.
  res.status(201).json({
    ...appointment,
    service: terms.service,
    serviceLabel: terms.serviceLabel,
    amountDueKes,
    paymentRequired: amountDueKes > 0,
    holdExpiresAt: amountDueKes > 0 ? holdExpiresAt(appointment.createdAt) : null,
  })
}))
