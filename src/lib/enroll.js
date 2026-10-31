import { prisma } from './prisma.js'

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
    const members = await client.user.count({ where: { institutionId: institution.id } })
    if (members >= institution.memberLimit) {
      return { status: 409, error: 'All the places for this code have been taken. You can still create an account without it.' }
    }
  }

  return { institution }
}
