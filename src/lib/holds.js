// How long a booked slot is held while the balance is unpaid. After this the
// slot is released so another patient can book it. Change it here only.
export const UNPAID_HOLD_MINUTES = 120

export function holdExpiresAt(createdAt) {
  return new Date(new Date(createdAt).getTime() + UNPAID_HOLD_MINUTES * 60 * 1000)
}
