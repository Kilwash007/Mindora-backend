import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole, requireAdminRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { initiateStkPush, normalizeKenyanPhone } from '../lib/mpesa.js'
import { assignClinician } from '../lib/triage.js'
import { notifyTriageQueued } from '../lib/triageNotify.js'

export const paymentRouter = Router()

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// A second payment prompt is refused for this long after the first, so a
// patient who answers a slow first prompt is never paying against a payment
// record that has already been replaced.
const PAYMENT_RETRY_GUARD_MS = 2 * 60 * 1000

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

// A completed triage is owed to its clinician once, when it was either free
// (a crisis triage or one covered by an institution, paid for by Mindora) or its KES payment is PAID. The
// amount was fixed at completion in clinicianPayoutKes.
async function findOwedTriages(clinicianId) {
  return prisma.triage.findMany({
    where: {
      ...(clinicianId ? { clinicianId } : { clinicianId: { not: null } }),
      payoutId: null,
      status: 'COMPLETED',
      clinicianPayoutKes: { gt: 0 },
      OR: [{ isFree: true }, { sponsoringInstitutionId: { not: null } }, { payment: { status: 'PAID' } }],
    },
    include: { clinician: { select: { id: true, fullName: true } } },
  })
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
  if (
    appointment.payment?.status === 'PENDING' &&
    Date.now() - new Date(appointment.payment.updatedAt).getTime() < PAYMENT_RETRY_GUARD_MS
  ) {
    return res.status(409).json({
      error: 'A payment prompt was just sent to your phone. Please answer it, or wait a minute and try again.',
      code: 'PAYMENT_PENDING',
    })
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
//
// A payment that is already PAID is never changed again, so a duplicate or
// late callback cannot undo a confirmed payment. When a payment is
// confirmed, what it was for is updated in the same transaction:
//   - a triage payment moves the triage into the queue and assigns a clinician
//   - an online appointment gets its video link
// ---------------------------------------------------------------------------

async function onTriagePaid(tx, payment) {
  const triage = await tx.triage.findUnique({ where: { id: payment.triageId } })
  if (!triage || triage.status !== 'AWAITING_PAYMENT') {
    console.error('[mpesa callback] Paid triage is not awaiting payment:', payment.triageId, triage?.status)
    return
  }
  const clinicianId = await assignClinician(tx)
  await tx.triage.update({
    where: { id: triage.id },
    data: { status: 'QUEUED', creditKes: payment.amountKes, clinicianId },
  })
}

async function onAppointmentPaid(tx, payment) {
  const appointment = await tx.appointment.findUnique({ where: { id: payment.appointmentId } })
  if (appointment && appointment.status === 'CANCELLED') {
    // The slot was released (or cancelled) before this payment arrived. The
    // money is real, so say so loudly: it needs a refund or a rebooking by hand.
    console.error('[mpesa callback] PAID FOR A CANCELLED APPOINTMENT: refund or rebook by hand.', {
      paymentId: payment.id,
      appointmentId: appointment.id,
      amountKes: payment.amountKes,
    })
  }
  if (appointment && appointment.type === 'ONLINE' && !appointment.meetingUrl && appointment.status !== 'CANCELLED') {
    await tx.appointment.update({
      where: { id: appointment.id },
      data: { meetingUrl: `https://meet.jit.si/mindora-${appointment.id}` },
    })
  }
}

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
    console.error('[mpesa callback] No matching payment for', body.CheckoutRequestID, JSON.stringify(req.body))
    return ack()
  }

  // Already confirmed: nothing a later callback says can change it.
  if (payment.status === 'PAID') return ack()

  const succeeded = body.ResultCode === 0
  let mpesaReceiptNumber = null

  if (succeeded && Array.isArray(body.CallbackMetadata?.Item)) {
    const item = body.CallbackMetadata.Item.find((i) => i.Name === 'MpesaReceiptNumber')
    mpesaReceiptNumber = item?.Value ?? null
  }

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, status: { not: 'PAID' } },
        data: {
          status: succeeded ? 'PAID' : 'FAILED',
          resultDesc: body.ResultDesc ?? null,
          mpesaReceiptNumber,
          paidAt: succeeded ? new Date() : null,
          rawCallback: req.body,
        },
      })
      if (claimed.count === 0) return // another callback got there first

      if (succeeded) {
        if (payment.triageId) await onTriagePaid(tx, payment)
        else if (payment.appointmentId) await onAppointmentPaid(tx, payment)
      }
    })
  } catch (err) {
    // Money may have moved. Log everything needed to reconcile by hand.
    console.error('[mpesa callback] FAILED to record payment', payment.id, err, JSON.stringify(req.body))
    return ack()
  }

  // A paid triage has joined the queue: tell the clinician. Never blocks the callback.
  if (succeeded && payment.triageId) notifyTriageQueued(payment.triageId)

  await audit({
    actorType: 'system',
    actorId: null,
    action: succeeded ? 'payment.succeeded' : 'payment.failed',
    resourceType: 'payment',
    resourceId: payment.id,
    metadata: { resultDesc: body.ResultDesc, mpesaReceiptNumber, triageId: payment.triageId ?? undefined },
  })

  ack()
}))

// ---------------------------------------------------------------------------
// Admin: the payout ledger — what's owed to each professional (sessions
// and triages), and recording a manual settlement
// ---------------------------------------------------------------------------

paymentRouter.get('/ledger', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const [owedAppointments, owedTriages] = await Promise.all([findOwedAppointments(), findOwedTriages()])

  const byProfessional = new Map()
  const entryFor = (id, name) => {
    if (!byProfessional.has(id)) {
      byProfessional.set(id, {
        professionalId: id,
        professionalName: name,
        owedKes: 0,
        appointmentCount: 0,
        appointmentIds: [],
        triageCount: 0,
        triageIds: [],
      })
    }
    return byProfessional.get(id)
  }

  for (const appt of owedAppointments) {
    const entry = entryFor(appt.professional.id, appt.professional.fullName)
    entry.owedKes += appt.feeKes - appt.platformFeeKes
    entry.appointmentCount += 1
    entry.appointmentIds.push(appt.id)
  }
  for (const t of owedTriages) {
    const entry = entryFor(t.clinician.id, t.clinician.fullName)
    entry.owedKes += t.clinicianPayoutKes
    entry.triageCount += 1
    entry.triageIds.push(t.id)
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
// — exactly the sessions and triages the ledger endpoint above would show
// them, computed fresh here so nothing can be settled twice by a stale list.
paymentRouter.post('/payouts', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const parsed = createPayoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { professionalId, method, reference, note } = parsed.data

  const [owedAppointments, owedTriages] = await Promise.all([
    findOwedAppointments({ professionalId }),
    findOwedTriages(professionalId),
  ])

  if (owedAppointments.length === 0 && owedTriages.length === 0) {
    return res.status(400).json({ error: 'Nothing is currently owed to this professional.' })
  }

  const totalOwedKes =
    owedAppointments.reduce((sum, a) => sum + (a.feeKes - a.platformFeeKes), 0) +
    owedTriages.reduce((sum, t) => sum + t.clinicianPayoutKes, 0)

  const appointmentIds = owedAppointments.map((a) => a.id)
  const triageIds = owedTriages.map((t) => t.id)

  let payout
  try {
    payout = await prisma.$transaction(async (tx) => {
      const created = await tx.payout.create({
        data: { professionalId, amountKes: totalOwedKes, method, reference, note },
      })
      // payoutId: null in the filter means a row another admin settled a
      // moment ago is not counted again; the whole batch is rolled back.
      const a = await tx.appointment.updateMany({
        where: { id: { in: appointmentIds }, payoutId: null },
        data: { payoutId: created.id },
      })
      const t = await tx.triage.updateMany({
        where: { id: { in: triageIds }, payoutId: null },
        data: { payoutId: created.id },
      })
      if (a.count !== appointmentIds.length || t.count !== triageIds.length) {
        throw new Error('LEDGER_CHANGED')
      }
      return created
    })
  } catch (err) {
    if (err.message === 'LEDGER_CHANGED') {
      return res.status(409).json({ error: 'The ledger changed while you were settling. Please reload and try again.' })
    }
    throw err
  }

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'payout.create',
    resourceType: 'payout',
    resourceId: payout.id,
    metadata: {
      professionalId,
      amountKes: totalOwedKes,
      appointmentCount: appointmentIds.length,
      triageCount: triageIds.length,
    },
  })

  res.status(201).json(payout)
}))

paymentRouter.get('/payouts', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const payouts = await prisma.payout.findMany({
    include: {
      professional: { select: { fullName: true } },
      appointments: { select: { id: true, scheduledFor: true, feeKes: true, platformFeeKes: true } },
      triages: { select: { id: true, completedAt: true, clinicianPayoutKes: true } },
    },
    orderBy: { paidAt: 'desc' },
  })
  res.json(payouts)
}))

// Professional's own view of what's been paid out to them.
paymentRouter.get('/payouts/mine', requireAuth, requireRole('professional'), wrap(async (req, res) => {
  const payouts = await prisma.payout.findMany({
    where: { professionalId: req.auth.id },
    include: {
      appointments: { select: { id: true, scheduledFor: true, feeKes: true, platformFeeKes: true } },
      triages: { select: { id: true, completedAt: true, clinicianPayoutKes: true } },
    },
    orderBy: { paidAt: 'desc' },
  })

  const [owedAppointments, owedTriages] = await Promise.all([
    findOwedAppointments({ professionalId: req.auth.id }),
    findOwedTriages(req.auth.id),
  ])
  const owedKes =
    owedAppointments.reduce((sum, a) => sum + (a.feeKes - a.platformFeeKes), 0) +
    owedTriages.reduce((sum, t) => sum + t.clinicianPayoutKes, 0)

  res.json({ payouts, owedKes })
}))
