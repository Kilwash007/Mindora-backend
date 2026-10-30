import { prisma } from './prisma.js'
import { sendTriageQueuedEmail } from './email.js'
import { TRIAGE_CLINICIAN_TYPES } from './triage.js'
import { CURRENT_AGREEMENT_VERSION } from './agreement.js'

// Who should be told that a triage is waiting.
//   - If a clinician is assigned, only that clinician.
//   - If nobody was assigned (nobody on call), every verified clinician who
//     could take it, so a patient never waits unseen.
// Nothing is returned for a triage that is not waiting in the queue. The
// notices carry no patient details; the email only says a triage is waiting.
export async function buildTriageNotices(triageId, client = prisma) {
  const triage = await client.triage.findUnique({
    where: { id: triageId },
    select: {
      status: true,
      isFree: true,
      urgency: true,
      clinician: { select: { email: true, fullName: true, deletedAt: true } },
    },
  })
  if (!triage || triage.status !== 'QUEUED') return []

  const urgent = triage.isFree || triage.urgency === 'URGENT'

  if (triage.clinician && !triage.clinician.deletedAt) {
    return [{ to: triage.clinician.email, name: triage.clinician.fullName, urgent, assigned: true }]
  }

  const clinicians = await client.professional.findMany({
    where: {
      verified: true,
      deletedAt: null,
      type: { in: TRIAGE_CLINICIAN_TYPES },
      agreementVersion: CURRENT_AGREEMENT_VERSION,
      agreementAcceptedAt: { not: null },
    },
    select: { email: true, fullName: true },
  })
  return clinicians.map((c) => ({ to: c.email, name: c.fullName, urgent, assigned: false }))
}

// Fire and forget: an email problem is logged and never breaks a payment
// callback, a screening or a triage.
export function notifyTriageQueued(triageId) {
  buildTriageNotices(triageId)
    .then(async (notices) => {
      for (const notice of notices) {
        try {
          await sendTriageQueuedEmail(notice.to, notice)
        } catch (err) {
          console.error('[triage notify] could not email a clinician:', err.message)
        }
      }
    })
    .catch((err) => console.error('[triage notify] failed:', err.message))
}
