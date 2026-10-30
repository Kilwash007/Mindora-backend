import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireRole, requireAgreement } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { initiateStkPush, normalizeKenyanPhone } from '../../lib/mpesa.js'
import { wrap, HttpError } from '../../lib/wrap.js'
import { findTriageSponsor } from '../../lib/sponsorship.js'
import { notifyTriageQueued } from '../../lib/triageNotify.js'
import { getPriceRow, priceFor, isStudentEligible, professionalPayoutKes } from '../../lib/priceList.js'
import {
  CRISIS_RESOURCES,
  TRIAGE_CLINICIAN_TYPES,
  ICD10_PATTERN,
  SERVICE_HOURS_LABEL,
  isScreeningValid,
  isWithinServiceHours,
  nextReviewBy,
  assignClinician,
} from '../../lib/triage.js'

export const triageRouter = Router()

// A second payment prompt is refused for this long after the first, so a
// patient who answers a slow first prompt is never paying against a payment
// record that has already been replaced.
const PAYMENT_RETRY_GUARD_MS = 2 * 60 * 1000

const USER_INCLUDE = {
  clinician: { select: { id: true, fullName: true, type: true } },
  sponsoringInstitution: { select: { name: true } },
  payment: true,
}

// What the patient sees. Clinical detail (ICD-10 code, the clinician's
// note) is not part of this view; it is in the data export.
function userView(t) {
  const now = new Date()
  const since = t.payment?.paidAt ?? t.createdAt
  return {
    id: t.id,
    checkInId: t.checkInId,
    status: t.status,
    isFree: t.isFree,
    sponsoredBy: t.sponsoringInstitution?.name ?? null,
    urgency: t.urgency,
    careLevel: t.careLevel,
    creditKes: t.creditKes,
    creditUsed: Boolean(t.creditAppointmentId),
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    clinician: t.clinician ?? null,
    payment: t.payment
      ? {
          status: t.payment.status,
          amountKes: t.payment.amountKes,
          mpesaReceiptNumber: t.payment.mpesaReceiptNumber,
          resultDesc: t.payment.resultDesc,
        }
      : null,
    care: {
      serviceHours: SERVICE_HOURS_LABEL,
      withinServiceHours: isWithinServiceHours(now),
      expectedResponseBy: t.status === 'QUEUED' ? nextReviewBy(since, now) : null,
    },
    crisis: CRISIS_RESOURCES,
  }
}

const CLINICIAN_INCLUDE = {
  user: {
    select: {
      id: true,
      fullName: true,
      dateOfBirth: true,
      sex: true,
      county: true,
      phone: true,
      nextOfKinName: true,
      nextOfKinPhone: true,
      nextOfKinRelationship: true,
    },
  },
  checkIn: { include: { answers: true } },
}

// What the assigned clinician sees. National ID number is deliberately left out.
function clinicianView(t) {
  return {
    id: t.id,
    status: t.status,
    isFree: t.isFree,
    urgency: t.urgency,
    careLevel: t.careLevel,
    icd10Code: t.icd10Code,
    icd10Label: t.icd10Label,
    summary: t.summary,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    patient: t.user,
    screening: {
      id: t.checkIn.id,
      riskLevel: t.checkIn.riskLevel,
      totalScore: t.checkIn.totalScore,
      maxScore: t.checkIn.maxScore,
      completedAt: t.checkIn.completedAt,
      answers: t.checkIn.answers,
    },
    crisis: CRISIS_RESOURCES,
  }
}

async function requireTriageClinician(professionalId) {
  const me = await prisma.professional.findUnique({
    where: { id: professionalId },
    select: { type: true, verified: true, deletedAt: true },
  })
  if (!me || !me.verified || me.deletedAt || !TRIAGE_CLINICIAN_TYPES.includes(me.type)) {
    throw new HttpError(403, 'Triage is not available for your account.')
  }
}

// ---------------------------------------------------------------------------
// Patient: start a triage from a valid screening
// ---------------------------------------------------------------------------

const createSchema = z.object({ checkInId: z.string().uuid() })

triageRouter.post('/', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const userId = req.auth.id
  const checkIn = await prisma.checkIn.findFirst({ where: { id: parsed.data.checkInId, userId } })
  if (!checkIn) throw new HttpError(404, 'Screening not found.')

  // One triage per screening: asking again returns the one that exists.
  const existing = await prisma.triage.findUnique({ where: { checkInId: checkIn.id }, include: USER_INCLUDE })
  if (existing) return res.json(userView(existing))

  if (!isScreeningValid(checkIn.completedAt)) {
    throw new HttpError(409, 'This screening is more than 30 days old. Please complete a new one.', 'SCREENING_EXPIRED')
  }

  // ACUTE always means PHQ-9 item 9 was positive: free, urgent, never a paywall.
  const crisis = checkIn.riskLevel === 'ACUTE'
  if (!crisis) {
    const row = await getPriceRow('TRIAGE')
    if (!row || !row.active) throw new HttpError(503, 'Triage is not available right now.', 'SERVICE_UNAVAILABLE')
  }

  // A pilot member whose institution covers triage gets their first triage
  // free (once). It skips payment and joins the queue like a paid triage.
  const sponsor = crisis ? null : await findTriageSponsor(userId)

  let created
  try {
    created = await prisma.$transaction(async (tx) => {
      const clinicianId = crisis || sponsor ? await assignClinician(tx) : null
      return tx.triage.create({
        data: {
          userId,
          checkInId: checkIn.id,
          isFree: crisis,
          status: crisis || sponsor ? 'QUEUED' : 'AWAITING_PAYMENT',
          urgency: crisis ? 'URGENT' : null,
          clinicianId,
          sponsoringInstitutionId: sponsor?.id ?? null,
        },
        include: USER_INCLUDE,
      })
    })
  } catch (err) {
    if (err.code === 'P2002') {
      const again = await prisma.triage.findUnique({ where: { checkInId: checkIn.id }, include: USER_INCLUDE })
      if (again) return res.json(userView(again))
    }
    throw err
  }

  // Covered and urgent triages skip payment and join the queue straight away.
  if (created.status === 'QUEUED') notifyTriageQueued(created.id)

  await audit({
    actorType: 'user',
    actorId: userId,
    action: 'triage.create',
    resourceType: 'triage',
    resourceId: created.id,
    metadata: { isFree: created.isFree, sponsored: Boolean(created.sponsoringInstitutionId) },
  })

  res.status(201).json(userView(created))
}))

triageRouter.get('/mine', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const triages = await prisma.triage.findMany({
    where: { userId: req.auth.id },
    include: USER_INCLUDE,
    orderBy: { createdAt: 'desc' },
  })
  res.json(triages.map(userView))
}))

// ---------------------------------------------------------------------------
// Clinician: the queue
// ---------------------------------------------------------------------------

triageRouter.get('/queue', requireAuth, requireRole('professional'), requireAgreement, wrap(async (req, res) => {
  await requireTriageClinician(req.auth.id)

  const items = await prisma.triage.findMany({
    where: {
      OR: [
        { clinicianId: req.auth.id, status: { in: ['QUEUED', 'IN_PROGRESS'] } },
        { clinicianId: null, status: 'QUEUED' },
      ],
    },
    include: {
      user: { select: { fullName: true } },
      checkIn: { select: { riskLevel: true, completedAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const unread = await prisma.message.groupBy({
    by: ['triageId'],
    where: { triageId: { in: items.map((i) => i.id) }, senderRole: 'user', readAt: null },
    _count: { _all: true },
  })
  const unreadById = new Map(unread.map((u) => [u.triageId, u._count._all]))

  // Crisis (free, urgent) triages first, then oldest first.
  const sorted = [...items].sort((a, b) => Number(b.isFree) - Number(a.isFree) || a.createdAt - b.createdAt)

  await audit({ actorType: 'professional', actorId: req.auth.id, action: 'triage.queue.list', resourceType: 'triage' })

  res.json(
    sorted.map((t) => ({
      id: t.id,
      status: t.status,
      isFree: t.isFree,
      urgency: t.urgency,
      createdAt: t.createdAt,
      assignedToMe: t.clinicianId === req.auth.id,
      patientName: t.user.fullName,
      riskLevel: t.checkIn.riskLevel,
      unreadMessages: unreadById.get(t.id) ?? 0,
    }))
  )
}))

// Take an unassigned triage (for example a crisis triage opened when
// nobody was on call).
triageRouter.post('/:id/claim', requireAuth, requireRole('professional'), requireAgreement, wrap(async (req, res) => {
  await requireTriageClinician(req.auth.id)

  const claimed = await prisma.triage.updateMany({
    where: { id: req.params.id, clinicianId: null, status: 'QUEUED' },
    data: { clinicianId: req.auth.id },
  })
  if (claimed.count === 0) throw new HttpError(409, 'This triage has already been taken or is no longer waiting.')

  await audit({ actorType: 'professional', actorId: req.auth.id, action: 'triage.claim', resourceType: 'triage', resourceId: req.params.id })
  res.json({ id: req.params.id, claimed: true })
}))

// ---------------------------------------------------------------------------
// One triage: the patient's view, or the assigned clinician's view
// ---------------------------------------------------------------------------

triageRouter.get('/:id', requireAuth, requireRole('user', 'professional'), wrap(async (req, res) => {
  if (req.auth.role === 'user') {
    const t = await prisma.triage.findUnique({ where: { id: req.params.id }, include: USER_INCLUDE })
    if (!t || t.userId !== req.auth.id) throw new HttpError(404, 'Triage not found.')
    return res.json(userView(t))
  }

  const t = await prisma.triage.findUnique({ where: { id: req.params.id }, include: CLINICIAN_INCLUDE })
  if (!t || t.clinicianId !== req.auth.id) throw new HttpError(404, 'Triage not found.')

  await audit({ actorType: 'professional', actorId: req.auth.id, action: 'triage.view', resourceType: 'triage', resourceId: t.id })
  res.json(clinicianView(t))
}))

// ---------------------------------------------------------------------------
// Patient: pay the triage fee by M-Pesa. The amount comes from the price
// list on the server; the client never sends it.
// ---------------------------------------------------------------------------

const paySchema = z.object({ phoneNumber: z.string().min(9) })

triageRouter.post('/:id/pay', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const parsed = paySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const triage = await prisma.triage.findUnique({ where: { id: req.params.id }, include: { payment: true } })
  if (!triage || triage.userId !== req.auth.id) throw new HttpError(404, 'Triage not found.')
  if (triage.isFree) throw new HttpError(400, 'This triage is free. There is nothing to pay.')
  if (triage.sponsoringInstitutionId) {
    throw new HttpError(400, 'This triage is covered by your institution. There is nothing to pay.')
  }
  if (triage.status !== 'AWAITING_PAYMENT' || triage.payment?.status === 'PAID') {
    throw new HttpError(409, 'This triage has already been paid for or is closed.')
  }
  if (
    triage.payment?.status === 'PENDING' &&
    Date.now() - new Date(triage.payment.updatedAt).getTime() < PAYMENT_RETRY_GUARD_MS
  ) {
    throw new HttpError(
      409,
      'A payment prompt was just sent to your phone. Please answer it, or wait a minute and try again.',
      'PAYMENT_PENDING'
    )
  }

  const phone = normalizeKenyanPhone(parsed.data.phoneNumber)
  if (!phone) throw new HttpError(400, 'Please enter a valid Kenyan phone number.')

  if (!process.env.PUBLIC_API_URL) throw new HttpError(500, 'Payments are not configured on this server yet.')

  const row = await getPriceRow('TRIAGE')
  if (!row || !row.active) throw new HttpError(503, 'Triage is not available right now.', 'SERVICE_UNAVAILABLE')
  const amountKes = priceFor(row, { isStudent: await isStudentEligible(req.auth.id) })

  let stk
  try {
    stk = await initiateStkPush({
      phoneNumber: phone,
      amountKes,
      accountReference: `MINDTRG${triage.id.slice(0, 5)}`,
      description: 'Mindora',
      callbackUrl: `${process.env.PUBLIC_API_URL}/api/payments/callback`,
    })
  } catch (err) {
    throw new HttpError(502, `Could not reach M-Pesa: ${err.message}`)
  }

  const payment = await prisma.payment.upsert({
    where: { triageId: triage.id },
    create: {
      triageId: triage.id,
      phoneNumber: phone,
      amountKes,
      status: 'PENDING',
      merchantRequestId: stk.merchantRequestId,
      checkoutRequestId: stk.checkoutRequestId,
    },
    update: {
      phoneNumber: phone,
      amountKes,
      status: 'PENDING',
      merchantRequestId: stk.merchantRequestId,
      checkoutRequestId: stk.checkoutRequestId,
      resultDesc: null,
      mpesaReceiptNumber: null,
      paidAt: null,
    },
  })

  await audit({
    actorType: 'user',
    actorId: req.auth.id,
    action: 'triage.payment.initiate',
    resourceType: 'payment',
    resourceId: payment.id,
    metadata: { triageId: triage.id, amountKes },
  })

  // The patient polls GET /:id until payment.status leaves PENDING.
  res.status(201).json({ status: payment.status, amountKes })
}))

// ---------------------------------------------------------------------------
// Triage chat (patient <-> assigned clinician), kept apart from therapy
// messages by triageId.
// ---------------------------------------------------------------------------

async function loadParticipantTriage(req) {
  const t = await prisma.triage.findUnique({ where: { id: req.params.id } })
  if (!t) throw new HttpError(404, 'Triage not found.')
  const isOwner = req.auth.role === 'user' && t.userId === req.auth.id
  const isClinician = req.auth.role === 'professional' && t.clinicianId === req.auth.id
  if (!isOwner && !isClinician) throw new HttpError(404, 'Triage not found.')
  return t
}

triageRouter.get('/:id/messages', requireAuth, requireRole('user', 'professional'), wrap(async (req, res) => {
  const t = await loadParticipantTriage(req)

  const messages = await prisma.message.findMany({
    where: { triageId: t.id },
    orderBy: { createdAt: 'asc' },
  })

  const incoming = req.auth.role === 'user' ? 'professional' : 'user'
  await prisma.message.updateMany({
    where: { triageId: t.id, senderRole: incoming, readAt: null },
    data: { readAt: new Date() },
  })

  res.json(messages)
}))

const messageSchema = z.object({ content: z.string().trim().min(1).max(2000) })

triageRouter.post('/:id/messages', requireAuth, requireRole('user', 'professional'), wrap(async (req, res) => {
  const parsed = messageSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const t = await loadParticipantTriage(req)
  if (!t.clinicianId) {
    throw new HttpError(409, 'A clinician has not been assigned yet. You can message as soon as one is.', 'NO_CLINICIAN')
  }
  if (t.status !== 'QUEUED' && t.status !== 'IN_PROGRESS') {
    throw new HttpError(409, 'This triage chat is closed.', 'TRIAGE_CLOSED')
  }

  const message = await prisma.message.create({
    data: {
      userId: t.userId,
      professionalId: t.clinicianId,
      senderRole: req.auth.role,
      content: parsed.data.content,
      triageId: t.id,
    },
  })

  // The clinician's first reply starts the triage.
  if (req.auth.role === 'professional' && t.status === 'QUEUED') {
    await prisma.triage.updateMany({
      where: { id: t.id, status: 'QUEUED' },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    })
  }

  await audit({
    actorType: req.auth.role,
    actorId: req.auth.id,
    action: 'triage.message.send',
    resourceType: 'message',
    resourceId: message.id,
  })

  res.status(201).json(message)
}))

// ---------------------------------------------------------------------------
// Clinician: finish the triage with the level of care, urgency and ICD-10
// code. The clinician's triage payout is fixed here from the price list.
// ---------------------------------------------------------------------------

const completeSchema = z.object({
  careLevel: z.enum(['COUNSELLING', 'PSYCHOLOGY', 'PSYCHIATRY', 'EMERGENCY_REFERRAL']),
  urgency: z.enum(['ROUTINE', 'SOON', 'URGENT']),
  icd10Code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(ICD10_PATTERN, 'Please enter a valid ICD-10 code, for example F32.1.'),
  icd10Label: z.string().trim().max(200).optional(),
  summary: z.string().trim().min(10).max(4000),
})

triageRouter.post('/:id/complete', requireAuth, requireRole('professional'), requireAgreement, wrap(async (req, res) => {
  const parsed = completeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const triage = await prisma.triage.findUnique({ where: { id: req.params.id } })
  if (!triage || triage.clinicianId !== req.auth.id) throw new HttpError(404, 'Triage not found.')
  if (triage.status === 'COMPLETED') throw new HttpError(409, 'This triage is already completed.')
  if (triage.status !== 'QUEUED' && triage.status !== 'IN_PROGRESS') {
    throw new HttpError(409, 'This triage cannot be completed in its current state.')
  }

  const row = await getPriceRow('TRIAGE')
  const clinicianPayoutKes = row ? professionalPayoutKes(row.priceKes, row.payoutPercent) : 0
  const d = parsed.data

  const done = await prisma.$transaction(async (tx) => {
    const updated = await tx.triage.updateMany({
      where: { id: triage.id, clinicianId: req.auth.id, status: { in: ['QUEUED', 'IN_PROGRESS'] } },
      data: {
        status: 'COMPLETED',
        careLevel: d.careLevel,
        urgency: d.urgency,
        icd10Code: d.icd10Code,
        icd10Label: d.icd10Label,
        summary: d.summary,
        completedAt: new Date(),
        startedAt: triage.startedAt ?? new Date(),
        clinicianPayoutKes,
      },
    })
    if (updated.count === 0) return false

    if (d.careLevel === 'EMERGENCY_REFERRAL') {
      await tx.safetyAlert.create({
        data: {
          userId: triage.userId,
          riskLevel: 'ACUTE',
          note: 'Triage outcome: emergency referral. Confirm the patient has been connected to emergency care.',
        },
      })
    }
    return true
  })
  if (!done) throw new HttpError(409, 'This triage was just changed. Please reload it.')

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: 'triage.complete',
    resourceType: 'triage',
    resourceId: triage.id,
    metadata: { careLevel: d.careLevel, urgency: d.urgency },
  })

  res.json({ id: triage.id, status: 'COMPLETED', careLevel: d.careLevel, urgency: d.urgency })
}))
