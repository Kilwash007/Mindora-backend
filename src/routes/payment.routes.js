import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole, requireAdminRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { initiateStkPush, normalizeKenyanPhone } from '../lib/mpesa.js'

export const paymentRouter = Router()

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// A completed appointment is owed to the professional (once not yet in a
// payout) when either the patient's M-Pesa payment is PAID, or an
// institution covered the whole fee so the patient never needed to pay —
// for example, free sessions in a Mindora-funded university pilot.
function isSettleable(appt) {
  if (appt.payment?.status === 'PAID') return true
  return !appt.payment && appt.sponsoringInstitutionId != null && appt.institutionCoveredKes >= appt.feeKes
}

async function findOwedAppointments(where = {}) {
  const candidates = await prisma.appointment.findMany({
    where: { ...where, payoutId: null, status: 'COMPLETED' },
    include: { payment: true, professional: { select: { id: true, fullName: true } } },
  })
  return candidates.filter(isSettleable)
}

// ---------------------------------------------------------------------------
// Patient: start a payment for one of their own appointments
// ---------------------------------------------------------------------------

const initiateSchema = z.object({
  appointmentId: z.string().uuid(),
  phoneNumber: z.string().min(9),
})

paymentRouter.post('/initiate', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const parsed = initiateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { appointmentId, phoneNumber } = parsed.data

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { payment: true },
  })
  if (!appointment || appointment.userId !== req.auth.id) {
    return res.status(404).json({ error: 'Appointment not found.' })
  }
  if (appointment.status === 'CANCELLED') {
    return res.status(400).json({ error: 'This appointment has been cancelled.' })
  }
  if (appointment.payment?.status === 'PAID') {
    return res.status(409).json({ error: 'This appointment has already been paid for.' })
  }

  // What the patient actually owes, net of any institution coverage.
  const amountDue = appointment.feeKes - appointment.institutionCoveredKes
  if (amountDue <= 0) {
    return res.status(400).json({ error: 'There is nothing to pay for this appointment.' })
  }

  const normalizedPhone = normalizeKenyanPhone(phoneNumber)
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Please enter a valid Kenyan phone number.' })
  }

  const callbackUrl = `${process.env.PUBLIC_API_URL}/api/payments/callback`
  if (!process.env.PUBLIC_API_URL) {
    // Fails loudly rather than silently sending Safaricom an unreachable
    // localhost URL it can never call back to.
    return res.status(500).json({ error: 'Payments are not configured on this server yet.' })
  }

  let stkResult
  try {
    stkResult = await initiateStkPush({
      phoneNumber: normalizedPhone,
      amountKes: amountDue,
      accountReference: `MIND${appointment.id.slice(0, 8)}`,
      description: 'Mindora',
      callbackUrl,
    })
  } catch (err) {
    return res.status(502).json({ error: `Could not reach M-Pesa: ${err.message}` })
  }

  // upsert: a patient retrying after a failed/expired push reuses the same
  // Payment row rather than erroring on the appointment's unique constraint.
  const payment = await prisma.payment.upsert({
    where: { appointmentId },
    create: {
      appointmentId,
      phoneNumber: normalizedPhone,
      amountKes: amountDue,
      status: 'PENDING',
      merchantRequestId: stkResult.merchantRequestId,
      checkoutRequestId: stkResult.checkoutRequestId,
    },
    update: {
      phoneNumber: normalizedPhone,
      amountKes: amountDue,
      status: 'PENDING',
      merchantRequestId: stkResult.merchantRequestId,
      checkoutRequestId: stkResult.checkoutRequestId,
      resultDesc: null,
      mpesaReceiptNumber: null,
      paidAt: null,
    },
  })

  await audit({
    actorType: 'user',
    actorId: req.auth.id,
    action: 'payment.initiate',
    resourceType: 'payment',
    resourceId: payment.id,
    metadata: { appointmentId, amountKes: amountDue },
  })

  res.status(201).json({ status: payment.status, checkoutRequestId: payment.checkoutRequestId })
}))

// Patient polls this while waiting for the STK push to be answered.
paymentRouter.get('/appointment/:appointmentId', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: req.params.appointmentId },
    include: { payment: true },
  })
  if (!appointment || appointment.userId !== req.auth.id) {
    return res.status(404).json({ error: 'Appointment not found.' })
  }

  if (!appointment.payment) {
    return res.json({ status: 'NOT_STARTED', amountDue: appointment.feeKes - appointment.institutionCoveredKes })
  }

  res.json({
    status: appointment.payment.status,
    amountKes: appointment.payment.amountKes,
    mpesaReceiptNumber: appointment.payment.mpesaReceiptNumber,
    resultDesc: appointment.payment.resultDesc,
  })
}))

// ---------------------------------------------------------------------------
// Safaricom's callback — the ONLY place a payment is ever marked PAID.
// No auth header will ever arrive here (Safaricom calls this directly),
// so this route is deliberately outside requireAuth. It always responds
// 200 with ResultCode 0 to Safaricom regardless of what we found, because
// a non-200 response makes Safaricom retry the callback repeatedly.
// ---------------------------------------------------------------------------

paymentRouter.post('/callback', wrap(async (req, res) => {
  const body = req.body?.Body?.stkCallback

  // Always acknowledge receipt, even for a payload we can't parse — this
  // stops Safaricom from retrying a request we'll never understand.
  const ack = () => res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' })

  if (!body?.CheckoutRequestID) {
    console.error('[mpesa callback] Unrecognized payload shape', JSON.stringify(req.body))
    return ack()
  }

  const payment = await prisma.payment.findUnique({
    where: { checkoutRequestId: body.CheckoutRequestID },
  })
  if (!payment) {
    console.error('[mpesa callback] No matching payment for', body.CheckoutRequestID)
    return ack()
  }

  const succeeded = body.ResultCode === 0
  let mpesaReceiptNumber = null

  if (succeeded && Array.isArray(body.CallbackMetadata?.Item)) {
    const item = body.CallbackMetadata.Item.find((i) => i.Name === 'MpesaReceiptNumber')
    mpesaReceiptNumber = item?.Value ?? null
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: succeeded ? 'PAID' : 'FAILED',
      resultDesc: body.ResultDesc ?? null,
      mpesaReceiptNumber,
      paidAt: succeeded ? new Date() : null,
      rawCallback: req.body,
    },
  })

  await audit({
    actorType: 'system',
    actorId: null,
    action: succeeded ? 'payment.succeeded' : 'payment.failed',
    resourceType: 'payment',
    resourceId: payment.id,
    metadata: { resultDesc: body.ResultDesc, mpesaReceiptNumber },
  })

  ack()
}))

// ---------------------------------------------------------------------------
// Admin: the payout ledger — what's owed to each professional, and
// recording a manual settlement
// ---------------------------------------------------------------------------

paymentRouter.get('/ledger', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const owedAppointments = await findOwedAppointments()

  const byProfessional = new Map()
  for (const appt of owedAppointments) {
    const payoutAmount = appt.feeKes - appt.platformFeeKes
    const key = appt.professional.id
    if (!byProfessional.has(key)) {
      byProfessional.set(key, {
        professionalId: appt.professional.id,
        professionalName: appt.professional.fullName,
        owedKes: 0,
        appointmentCount: 0,
        appointmentIds: [],
      })
    }
    const entry = byProfessional.get(key)
    entry.owedKes += payoutAmount
    entry.appointmentCount += 1
    entry.appointmentIds.push(appt.id)
  }

  res.json(Array.from(byProfessional.values()).sort((a, b) => b.owedKes - a.owedKes))
}))

const createPayoutSchema = z.object({
  professionalId: z.string().uuid(),
  method: z.string().trim().min(2).max(60),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
})

// Settles everything currently owed to one professional in a single batch
// — exactly the appointments the ledger endpoint above would show them,
// computed fresh here so nothing can be settled twice by a stale list.
paymentRouter.post('/payouts', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const parsed = createPayoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { professionalId, method, reference, note } = parsed.data

  const owedAppointments = await findOwedAppointments({ professionalId })

  if (owedAppointments.length === 0) {
    return res.status(400).json({ error: 'Nothing is currently owed to this professional.' })
  }

  const totalOwedKes = owedAppointments.reduce((sum, a) => sum + (a.feeKes - a.platformFeeKes), 0)

  const payout = await prisma.$transaction(async (tx) => {
    const created = await tx.payout.create({
      data: { professionalId, amountKes: totalOwedKes, method, reference, note },
    })
    await tx.appointment.updateMany({
      where: { id: { in: owedAppointments.map((a) => a.id) } },
      data: { payoutId: created.id },
    })
    return created
  })

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'payout.create',
    resourceType: 'payout',
    resourceId: payout.id,
    metadata: { professionalId, amountKes: totalOwedKes, appointmentCount: owedAppointments.length },
  })

  res.status(201).json(payout)
}))

paymentRouter.get('/payouts', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const payouts = await prisma.payout.findMany({
    include: {
      professional: { select: { fullName: true } },
      appointments: { select: { id: true, scheduledFor: true, feeKes: true, platformFeeKes: true } },
    },
    orderBy: { paidAt: 'desc' },
  })
  res.json(payouts)
}))

// Professional's own view of what's been paid out to them.
paymentRouter.get('/payouts/mine', requireAuth, requireRole('professional'), wrap(async (req, res) => {
  const payouts = await prisma.payout.findMany({
    where: { professionalId: req.auth.id },
    include: { appointments: { select: { id: true, scheduledFor: true, feeKes: true, platformFeeKes: true } } },
    orderBy: { paidAt: 'desc' },
  })

  const owedAppointments = await findOwedAppointments({ professionalId: req.auth.id })
  const owedKes = owedAppointments.reduce((sum, a) => sum + (a.feeKes - a.platformFeeKes), 0)

  res.json({ payouts, owedKes })
}))