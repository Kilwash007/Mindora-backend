import { app } from './app.js'
import { startAppointmentReminderJob } from './jobs/appointmentReminders.js'
import { startTriageEscalationJob } from './jobs/triageEscalations.js'
import { startReleaseUnpaidSlotsJob } from './jobs/releaseUnpaidSlots.js'
import { startPurgeProofFilesJob } from './jobs/purgeProofFiles.js'

// Process-level safety nets. A failed promise anywhere in the app (e.g. a
// background job losing the database connection) is logged instead of
// shutting the API down. A truly uncaught exception leaves the process in an
// unknown state, so we log it and exit; Render restarts the service.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled promise rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception, exiting:', err)
  process.exit(1)
})

const port = process.env.PORT || 4000
app.listen(port, () => {
  console.log(`Mindora API listening on http://localhost:${port} [${process.env.NODE_ENV}]`)
  startAppointmentReminderJob()
  startTriageEscalationJob()
  startReleaseUnpaidSlotsJob()
  startPurgeProofFilesJob()
})
