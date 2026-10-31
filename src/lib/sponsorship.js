import { prisma } from './prisma.js'

// Pilot cover for triage. A triage is covered (free to the person, paid for
// by Mindora) when the person is linked to an ACTIVE institution that covers
// triage, has shown they qualify if the programme asks for proof, and has not
// already had a covered triage. It is one per person. A crisis triage is
// always free and never counts against this one.
// Pass a transaction client to run it inside a transaction.

// A programme that requires student proof only applies to people whose proof
// an admin has approved (studentRateEligible).
export function meetsProgrammeProof(institution, user) {
  return !institution?.requiresStudentProof || Boolean(user?.studentRateEligible)
}

export async function findTriageSponsor(userId, client = prisma) {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: {
      studentRateEligible: true,
      institution: { select: { id: true, name: true, status: true, coversTriage: true, requiresStudentProof: true } },
    },
  })
  const institution = user?.institution
  if (!institution || institution.status !== 'ACTIVE' || !institution.coversTriage) return null
  if (!meetsProgrammeProof(institution, user)) return null

  const alreadyCovered = await client.triage.count({
    where: { userId, sponsoringInstitutionId: { not: null }, status: { not: 'CANCELLED' } },
  })
  return alreadyCovered > 0 ? null : institution
}

// True once the person has had their covered triage.
export async function hasUsedCoveredTriage(userId, client = prisma) {
  const count = await client.triage.count({
    where: { userId, sponsoringInstitutionId: { not: null }, status: { not: 'CANCELLED' } },
  })
  return count > 0
}
