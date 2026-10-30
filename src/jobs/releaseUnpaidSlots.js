import { prisma } from '../lib/prisma.js'
import { sendSlotReleasedEmail } from '../lib/email.js'
import { UNPAID_HOLD_MINUTES } from '../lib/holds.js'

// Releases a booked slot when its balance has not been paid in time, so a
// professional's calendar is not blocked by bookings that never happen.
//
// Only sessions booked through the new flow (they have a serviceType) are
// touched; bookings made the old way are left exactly as they are. Nothing
// that is paid, partly in progress, or fully covered by an institution is
// ever released. Releasing sets the appointment to CANCELLED, which also
// gives back the triage credit and any covered session.

const CHECK_INTERVAL_MS = 10 * 60 * 1000
// An M-Pesa prompt stays open on the phone for about a minute, so a payment
// started in the last few minutes is given time to finish.
const PAYMENT_IN_FLIGHT_MS = 10 * 60 * 1000

// Pure: should this appointment be released at `now`?
export function isReleasable(appt, now = new Date()) {
  if (appt.status !== 'SCHEDULED' || !appt.serviceType) return false
  if (appt.feeKes - appt.institutionCoveredKes <= 0) return false
  if (now.getTime() - new Date(appt.createdAt).getTime() < UNPAID_HOLD_MINUTES * 60 * 1000) return false
  if (appt.payment?.status === 'PAID') return false
  if (appt.payment?.status === 'PENDING' && now.getTime() - new Date(appt.payment.updatedAt).getTime() < PAYMENT_IN_FLIGHT_MS) {
    return false
  }
  return true
}

// Exported so it can be tested with a fixed clock and a fake sender.
// onlyIds limits the check to certain appointments (used by tests).
export async function releaseUnpaidSlots({ now = new Date(), send = sendSlotReleasedEmail, onlyIds, client = prisma } = {}) {
  const cutoff = new Date(now.getTime() - UNPAID_HOLD_MINUTES * 60 * 1000)

  const candidates = await client.appointment.findMany({
    where: {
      status: 'SCHEDULED',
      serviceType: { not: null },
      createdAt: { lte: cutoff },
      ...(onlyIds ? { id: { in: onlyIds } } : {}),
    },
    select: {
      id: true,
      status: true,
      serviceType: true,
      feeKes: true,
      institutionCoveredKes: true,
      scheduledFor: true,
      createdAt: true,
      user: { select: { email: true } },
      professional: { select: { fullName: true } },
      payment: { select: { status: true, updatedAt: true } },
    },
  })

  let released = 0
  for (const appt of candidates) {
    if (!isReleasable(appt, now)) continue

    try {
      // Re-checks "not paid" inside the update itself, so a payment that
      // lands at this very moment is never cancelled.
      const done = await client.appointment.updateMany({
        where: {
          id: appt.id,
          status: 'SCHEDULED',
          OR: [{ payment: { is: null } }, { payment: { is: { status: { not: 'PAID' } } } }],
        },
        data: { status: 'CANCELLED' },
      })
      if (done.count === 0) continue
      released += 1
      console.log(`[slots] released unpaid appointment ${appt.id}`)

      try {
        await send(appt.user.email, {
          professionalName: appt.professional.fullName,
          scheduledFor: appt.scheduledFor,
          holdMinutes: UNPAID_HOLD_MINUTES,
        })
      } catch (err) {
        console.error(`[slots] released ${appt.id} but could not email the patient:`, err.message)
      }
    } catch (err) {
      console.error(`[slots] failed for appointment ${appt.id}:`, err)
    }
  }

  return { released }
}

// Same shape as the other jobs: in the server process, guarded against
// overlapping runs, and never allowed to take the API down.
let isRunning = false

async function tick() {
  if (isRunning) return
  isRunning = true
  try {
    const { released } = await releaseUnpaidSlots()
    if (released) console.log(`[slots] released ${released} unpaid slot${released === 1 ? '' : 's'}`)
  } catch (err) {
    // Usually the free-tier database waking up (Prisma P1001): wait for the next run.
    console.warn(
      `[slots] could not check unpaid slots (${err.code || err.name}): ${String(err.message).split('\n').filter(Boolean).pop()} — will retry next check`
    )
  } finally {
    isRunning = false
  }
}

export function startReleaseUnpaidSlotsJob() {
  setTimeout(tick, 30 * 1000)
  setInterval(tick, CHECK_INTERVAL_MS)
  console.log('[slots] unpaid slot release job started')
}
