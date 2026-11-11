import { prisma } from './prisma.js'

// Pilot places (Institution.memberLimit).
//
// A place is taken by a member who actually qualifies for the programme:
// - a programme that asks for student proof: only members whose proof an
//   admin has approved (studentRateEligible). Signing up with the code, or
//   sending proof that is still waiting, does not take a place.
// - any other programme: every linked member.
// Pass a transaction client to count inside a transaction.
export async function countSeatsUsed(institution, client = prisma) {
  const where = { institutionId: institution.id, deletedAt: null }
  if (institution.requiresStudentProof) where.studentRateEligible = true
  return client.user.count({ where })
}

export function seatsFull(institution, used) {
  return institution.memberLimit != null && used >= institution.memberLimit
}

// Looks up a pilot or promo code for someone who is signing up with it.
// Returns { institution } when the code can be used, or { status, error }
// with a message the person can act on. The code is not case sensitive.
export async function findEnrollableInstitution(rawCode, client = prisma) {
  const code = String(rawCode ?? '').trim().toUpperCase()
  const institution = code ? await client.institution.findUnique({ where: { enrollmentCode: code } }) : null

  if (!institution || institution.status !== 'ACTIVE') {
    return { status: 404, error: 'That code is not valid. Check it and try again, or leave it blank.' }
  }

  if (institution.memberLimit != null) {
    const used = await countSeatsUsed(institution, client)
    if (seatsFull(institution, used)) {
      return { status: 409, error: 'All the places for this code have been taken. You can still create an account without it.' }
    }
  }

  return { institution }
}
