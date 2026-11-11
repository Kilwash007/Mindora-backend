import { z } from 'zod'

// Mindora is for adults only. Anyone under 18 is turned away at sign-up (no
// account is created and nothing is stored) and shown crisis lines they can
// use straight away.
export const MIN_AGE = 18

// Kenya is UTC+3 all year (no daylight saving), so "today" for an age check
// is the calendar date in Nairobi, not the server's UTC date.
const KENYA_OFFSET_MS = 3 * 60 * 60 * 1000

function todayInKenya(now = new Date()) {
  const k = new Date(now.getTime() + KENYA_OFFSET_MS)
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate() }
}

// "YYYY-MM-DD" -> a Date at midnight UTC, which is how dateOfBirth is stored.
export function dobToDate(value) {
  return new Date(`${value}T00:00:00Z`)
}

// Whole years old today (in Kenya) for a stored or submitted date of birth.
export function ageOn(dob, now = new Date()) {
  const date = dob instanceof Date ? dob : dobToDate(dob)
  const t = todayInKenya(now)
  const by = date.getUTCFullYear()
  const bm = date.getUTCMonth() + 1
  const bd = date.getUTCDate()
  let age = t.y - by
  if (t.m < bm || (t.m === bm && t.d < bd)) age -= 1
  return age
}

export function isUnder18(dob, now = new Date()) {
  return ageOn(dob, now) < MIN_AGE
}

// A real calendar date (so 2001-02-30 is refused), not in the future, and
// not more than 120 years ago.
export const dateOfBirthField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((v) => {
    const d = dobToDate(v)
    if (Number.isNaN(d.getTime())) return false
    if (d.toISOString().slice(0, 10) !== v) return false
    const age = ageOn(d)
    return age >= 0 && age <= 120
  }, 'Please enter a valid date of birth.')

// The same lines appear on the frontend's age screen.
const CRISIS_LINES =
  'If you need someone to talk to, call Childline Kenya on 116 (free, any time). In an emergency, call 999 or 112, or Kenya Red Cross on 1199 (free).'

export const UNDER_18_SIGNUP = {
  error: `Mindora is for people aged 18 and over, so we can't create an account for you. ${CRISIS_LINES}`,
  code: 'UNDER_18',
}

export const UNDER_18_ACCOUNT = {
  error: `Mindora is for people aged 18 and over, so we can't continue with this account. ${CRISIS_LINES}`,
  code: 'UNDER_18',
}
