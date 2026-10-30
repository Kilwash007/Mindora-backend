// Field lists for anything sent to a client. Never return a raw account row:
// it carries passwordHash, and professionals' contact details must not reach
// patients (messaging exists so nobody has to exchange them).

// What any signed-in person may see about a verified professional.
export const PUBLIC_PROFESSIONAL_SELECT = {
  id: true,
  fullName: true,
  type: true,
  bio: true,
  qualifications: true,
  focusAreas: true,
  languages: true,
  yearsExperience: true,
  location: true,
  feeKes: true,
  studentRateFeeKes: true,
  supervisorName: true,
  onlineAvailable: true,
  inPersonAvailable: true,
  verified: true,
  createdAt: true,
}

// For a person's own record: everything except the password hash.
export function stripSecrets(record) {
  if (!record) return record
  const { passwordHash: _passwordHash, ...rest } = record
  return rest
}
