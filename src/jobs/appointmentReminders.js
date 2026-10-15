import { prisma } from '../lib/prisma.js'
import { sendAppointmentReminderEmail } from '../lib/email.js'

const CHECK_INTERVAL_MS = 10 * 60 * 1000 // every 10 minutes
const REMINDER_WINDOW_HOURS = 24

// Prevents a slow run (e.g. the database waking up) from overlapping with
// the next scheduled run and sending the same reminder twice.
let isRunning = false

// Finds SCHEDULED appointments entering their 24-hour reminder window that
// haven't already been reminded, and emails each patient once. Runs inside
// the same process rather than a separate job queue — appropriate for this
// stage (single server instance, no deployed infrastructure for a real job
// runner yet). Revisit this if/when the backend runs on multiple instances,
// since two instances would each try to send the same reminders.
async function checkAndSendReminders() {
  if (isRunning) {
    console.warn('[reminders] previous run still in progress, skipping this tick')
    return
  }
  isRunning = true

  try {
    const now = new Date()
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000)

    let dueAppointments
    try {
      dueAppointments = await prisma.appointment.findMany({
        where: {
          status: 'SCHEDULED',
          reminderSentAt: null,
          scheduledFor: { gt: now, lte: windowEnd },
        },
        include: { user: true, professional: true },
      })
    } catch (err) {
      // Usually the free-tier database waking up (Prisma P1001). Log briefly
      // and wait for the next tick instead of crashing the whole API.
      console.warn(
        `[reminders] could not query appointments (${err.code || err.name}): ${String(err.message).split('\n').filter(Boolean).pop()} — will retry next check`
      )
      return
    }

    for (const appt of dueAppointments) {
      try {
        await sendAppointmentReminderEmail(appt.user.email, {
          professionalName: appt.professional.fullName,
          scheduledFor: appt.scheduledFor,
          type: appt.type,
          meetingUrl: appt.meetingUrl,
        })
        await prisma.appointment.update({
          where: { id: appt.id },
          data: { reminderSentAt: new Date() },
        })
        console.log(`[reminders] sent for appointment ${appt.id}`)
      } catch (err) {
        // One failed email shouldn't stop the rest from sending — log and
        // move on; reminderSentAt stays null so it'll be retried next check.
        console.error(`[reminders] failed for appointment ${appt.id}:`, err)
      }
    }
  } catch (err) {
    // Last line of defence: nothing in this job may take the server down.
    console.error('[reminders] unexpected error:', err)
  } finally {
    isRunning = false
  }
}

export function startAppointmentReminderJob() {
  // Run once shortly after startup, then on the regular interval.
  setTimeout(checkAndSendReminders, 10 * 1000)
  setInterval(checkAndSendReminders, CHECK_INTERVAL_MS)
  console.log('[reminders] appointment reminder job started')
}