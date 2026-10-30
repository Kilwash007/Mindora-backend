import { prisma } from './prisma.js'

// How the professional's payout is worked out when a triage credit lowers
// what the patient pays for their first session.
//   true  = the professional is paid their percentage of the FULL list
//           price (e.g. 65% of 2,500 = 1,625). Mindora absorbs the credit.
//   false = the professional is paid their percentage of what the patient
//           actually paid (65% of 2,000 = 1,300).
// This is a business decision: change it here, nowhere else.
export const PAYOUT_ON_FULL_PRICE = true

export const SERVICE_LABELS = {
  TRIAGE: 'Triage',
  COUNSELLING: 'Counselling',
  PSYCHOLOGY: 'Psychology',
  PSYCHIATRY_INITIAL: 'Psychiatry (initial)',
  PSYCHIATRY_FOLLOWUP: 'Psychiatry (follow-up)',
}

// The price row for a service, whether or not it is currently on sale.
// Callers that sell the service check row.active themselves.
export async function getPriceRow(service, client = prisma) {
  return client.servicePrice.findUnique({ where: { service } })
}

// What the patient is charged: the student price when they are eligible
// and one has been set, otherwise the standard price.
export function priceFor(row, { isStudent = false } = {}) {
  if (isStudent && row.studentPriceKes != null) return row.studentPriceKes
  return row.priceKes
}

export function professionalPayoutKes(basePriceKes, payoutPercent) {
  return Math.round((basePriceKes * payoutPercent) / 100)
}

// A verified student (Student Rate) or a member of an active university
// (the enrollment code is itself the proof of student status).
export async function isStudentEligible(userId, client = prisma) {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { studentRateEligible: true, institution: { select: { type: true, status: true } } },
  })
  const universityMember = user?.institution?.type === 'UNIVERSITY' && user?.institution?.status === 'ACTIVE'
  return Boolean(user?.studentRateEligible || universityMember)
}
