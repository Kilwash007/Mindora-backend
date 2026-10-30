import { prisma } from '../lib/prisma.js'
import { sendTriageOverdueEmail } from '../lib/email.js'
import { addServiceMinutes } from '../lib/serviceHours.js'
import { TRIAGE_CLINICIAN_TYPES } from '../lib/triage.js'
import { CURRENT_AGREEMENT_VERSION } from '../lib/agreement.js'

// Backstop for the promise to patients: a first reply within 2 hours between
// 8am and 8pm EAT. The clinician is emailed when a triage is queued
// (triageNotify.js); this job is what happens if nobody answers.
//
//   remind   - the assigned clinician is reminded (everyone, if nobody has it)
//   escalate - the triage is released so ANY eligible clinician can take it,
//              every eligible clinician is emailed, and so are the people in
//              TRIAGE_ESCALATION_EMAIL (comma separated)
//
// Minutes are service-hours minutes (see serviceHours.js), counted from when
// the triage joined the queue. An urgent triage runs on a much shorter clock.
// "Waiting" means no clinician has replied yet (status QUEUED).
export const TIMINGS = {
  routine: { remind: 90, escalate: 120 },
  urgent: { remind: 30, escalate: 60 },
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000

const isUrgent = (t) => Boolean(t.isFree) || t.urgency === 'URGENT'

// Pure: which step, if any, is due for this triage at `now`.
export function dueStage(triage, now = new Date()) {
  if (triage.escalatedAt) return null
  const queuedAt = triage.payment?.paidAt ?? triage.createdAt
  const timing = isUrgent(triage) ? TIMINGS.urgent : TIMINGS.routine
  if (addServiceMinutes(queuedAt, timing.escalate) <= now) return 'escalate'
  if (!triage.reminderSentAt && addServiceMinutes(queuedAt, timing.remind) <= now) return 'remind'
  return null
}

function adminAddresses() {
  return (process.env.TRIAGE_ESCALATION_EMAIL || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
}

function findEligibleClinicians(client) {
  return client.professional.findMany({
    where: {
      verified: true,
      deletedAt: null,
      type: { in: TRIAGE_CLINICIAN_TYPES },
      agreementVersion: CURRENT_AGREEMENT_VERSION,
      agreementAcceptedAt: { not: null },
    },
    select: { email: true, fullName: true },
  })
}

// One failed email must not stop the rest.
async function deliver(send, notices) {
  for (const notice of notices) {
    try {
      await send(notice.to, notice)
    } catch (err) {
      console.error('[triage escalation] could not send an email:', err.message)
    }
  }
}

// Exported so it can be tested with a fixed clock and a fake sender.
// onlyIds limits the check to certain triages (used by tests).
export async function checkTriageEscalations({ now = new Date(), send = sendTriageOverdueEmail, onlyIds, client = prisma } = {}) {
  const summary = { reminded: 0, escalated: 0 }

  const waiting = await client.triage.findMany({
    where: { status: 'QUEUED', escalatedAt: null, ...(onlyIds ? { id: { in: onlyIds } } : {}) },
    select: {
      id: true,
      isFree: true,
      urgency: true,
      createdAt: true,
      reminderSentAt: true,
      escalatedAt: true,
      payment: { select: { paidAt: true } },
      clinician: { select: { email: true, fullName: true, deletedAt: true } },
    },
  })

  let eligible
  const loadEligible = async () => (eligible ??= await findEligibleClinicians(client))

  for (const t of waiting) {
    const stage = dueStage(t, now)
    if (!stage) continue
    const urgent = isUrgent(t)

    try {
      if (stage === 'remind') {
        // The guarded update is what makes this happen once, even if two
        // runs overlap.
        const claimed = await client.triage.updateMany({
          where: { id: t.id, status: 'QUEUED', reminderSentAt: null, escalatedAt: null },
          data: { reminderSentAt: now },
        })
        if (claimed.count === 0) continue
        summary.reminded += 1

        if (t.clinician && !t.clinician.deletedAt) {
          await deliver(send, [{ to: t.clinician.email, name: t.clinician.fullName, urgent, stage: 'reminder' }])
        } else {
          const clinicians = await loadEligible()
          await deliver(send, clinicians.map((c) => ({ to: c.email, name: c.fullName, urgent, stage: 'unassigned' })))
        }
      } else {
        // Release it: with no one assigned, any eligible clinician can take it.
        const claimed = await client.triage.updateMany({
          where: { id: t.id, status: 'QUEUED', escalatedAt: null },
          data: { escalatedAt: now, clinicianId: null },
        })
        if (claimed.count === 0) continue
        summary.escalated += 1

        const clinicians = await loadEligible()
        const notices = clinicians.map((c) => ({ to: c.email, name: c.fullName, urgent, stage: 'released' }))
        const admins = adminAddresses()
        if (admins.length === 0) {
          console.warn('[triage escalation] TRIAGE_ESCALATION_EMAIL is not set, so nobody outside the clinicians was told')
        }
        for (const to of admins) notices.push({ to, name: 'team', urgent, stage: 'admin' })
        await deliver(send, notices)
        console.log(`[triage escalation] released triage ${t.id} to all eligible clinicians`)
      }
    } catch (err) {
      console.error(`[triage escalation] failed for triage ${t.id}:`, err)
    }
  }

  return summary
}

// Same shape as the appointment reminder job: in the server process, guarded
// against overlapping runs, and never allowed to take the API down.
let isRunning = false

async function tick() {
  if (isRunning) return
  isRunning = true
  try {
    const summary = await checkTriageEscalations()
    if (summary.reminded || summary.escalated) {
      console.log(`[triage escalation] reminded ${summary.reminded}, escalated ${summary.escalated}`)
    }
  } catch (err) {
    // Usually the free-tier database waking up (Prisma P1001): wait for the next run.
    console.warn(
      `[triage escalation] could not check the queue (${err.code || err.name}): ${String(err.message).split('\n').filter(Boolean).pop()} — will retry next check`
    )
  } finally {
    isRunning = false
  }
}

export function startTriageEscalationJob() {
  setTimeout(tick, 20 * 1000)
  setInterval(tick, CHECK_INTERVAL_MS)
  console.log('[triage escalation] job started')
}
