import { prisma } from './prisma.js'
import { sendProofReviewedEmail } from './email.js'

// Tells a person what was decided about their proof of being a student. It
// says nothing beyond that; the reviewer's notes are shown in the app, not
// sent by email.
// Returns false (and sends nothing) when the request has not been decided.
export async function emailProofDecision(verificationId, { client = prisma, send = sendProofReviewedEmail } = {}) {
  const v = await client.studentRateVerification.findUnique({
    where: { id: verificationId },
    select: {
      status: true,
      user: {
        select: {
          email: true,
          fullName: true,
          institution: { select: { name: true, coversTriage: true, requiresStudentProof: true } },
        },
      },
    },
  })
  if (!v || (v.status !== 'APPROVED' && v.status !== 'REJECTED')) return false

  const programme = v.user.institution
  await send(v.user.email, {
    name: v.user.fullName,
    approved: v.status === 'APPROVED',
    programme: programme?.name ?? null,
    freeTriage: Boolean(programme?.coversTriage && programme?.requiresStudentProof),
  })
  return true
}

// Fire and forget: an email problem is logged and never undoes a review.
export function notifyProofDecision(verificationId) {
  emailProofDecision(verificationId).catch((err) => {
    console.error('[proof] could not email the decision:', err.message)
  })
}
