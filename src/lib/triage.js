import { CURRENT_AGREEMENT_VERSION } from './agreement.js'

// ---------------------------------------------------------------------------
// Crisis resources. Keep these identical to the numbers on the check-in
// result screens.
// ---------------------------------------------------------------------------

export const CRISIS_RESOURCES = [
  { name: 'Emergency services', phone: '999 or 112', hours: '24 hours' },
  { name: 'Kenya Red Cross', phone: '1199', hours: '24 hours, toll-free' },
  { name: 'Befrienders Kenya', phone: '+254 722 178 177', hours: 'Weekdays, 9am to 5pm' },
]

export const SUBSTANCE_RESOURCE = { name: 'NACADA helpline', phone: '1192', hours: '24 hours' }

// ---------------------------------------------------------------------------
// Screening validity: a screening can start a triage for 30 days.
// ---------------------------------------------------------------------------

export const SCREENING_VALID_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export function screeningValidUntil(completedAt) {
  return new Date(new Date(completedAt).getTime() + SCREENING_VALID_DAYS * DAY_MS)
}

export function isScreeningValid(completedAt, now = new Date()) {
  return screeningValidUntil(completedAt) > now
}

// ---------------------------------------------------------------------------
// Who does what. Edit these lists to change the rota or the service rules.
// ---------------------------------------------------------------------------

// Professional types that can be put on the triage rota.
export const TRIAGE_CLINICIAN_TYPES = [
  'PSYCHIATRIC_CLINICAL_OFFICER',
  'PSYCHIATRIC_NURSE',
  'PSYCHOLOGIST',
  'CLINICAL_PSYCHOLOGIST',
  'PSYCHIATRIST',
]

// Professional types that may deliver each bookable service.
export const SERVICE_PROFESSIONAL_TYPES = {
  COUNSELLING: [
    'COUNSELLOR',
    'PSYCHIATRIC_NURSE',
    'PSYCHIATRIC_CLINICAL_OFFICER',
    'PSYCHOLOGIST',
    'CLINICAL_PSYCHOLOGIST',
  ],
  PSYCHOLOGY: ['PSYCHOLOGIST', 'CLINICAL_PSYCHOLOGIST'],
  PSYCHIATRY_INITIAL: ['PSYCHIATRIST'],
  PSYCHIATRY_FOLLOWUP: ['PSYCHIATRIST'],
}

// The level of care a clinician assigns decides which service is booked.
// PSYCHIATRY becomes a follow-up once an initial visit has been completed.
export const CARE_LEVEL_SERVICE = {
  COUNSELLING: 'COUNSELLING',
  PSYCHOLOGY: 'PSYCHOLOGY',
  PSYCHIATRY: 'PSYCHIATRY_INITIAL',
}

// ICD-10 code shape, e.g. F32.1, F41.1, Z63.0. Checks the format only, not
// that the code exists.
export const ICD10_PATTERN = /^[A-TV-Z][0-9][0-9AB](\.[0-9A-TV-Z]{1,4})?$/

// ---------------------------------------------------------------------------
// Service hours: chat triage is answered within 2 hours between 8am and 8pm
// East Africa Time (UTC+3, no daylight saving).
// ---------------------------------------------------------------------------

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000
const OPEN_MIN = 8 * 60
const CLOSE_MIN = 20 * 60
const RESPONSE_MIN = 120

export const SERVICE_HOURS_LABEL = '8:00 am to 8:00 pm EAT'

export function isWithinServiceHours(now = new Date()) {
  const t = new Date(now.getTime() + EAT_OFFSET_MS)
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes()
  return mins >= OPEN_MIN && mins < CLOSE_MIN
}

// When a clinician should have replied by, counting only service hours.
export function expectedResponseBy(from) {
  const shifted = new Date(new Date(from).getTime() + EAT_OFFSET_MS)
  let day = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  let mins = shifted.getUTCHours() * 60 + shifted.getUTCMinutes() + shifted.getUTCSeconds() / 60

  if (mins < OPEN_MIN) mins = OPEN_MIN
  else if (mins >= CLOSE_MIN) {
    day += DAY_MS
    mins = OPEN_MIN
  }

  let remaining = RESPONSE_MIN
  const available = CLOSE_MIN - mins
  if (remaining <= available) {
    mins += remaining
  } else {
    remaining -= available
    day += DAY_MS
    mins = OPEN_MIN + remaining
  }
  return new Date(day + mins * 60000 - EAT_OFFSET_MS)
}

// The time to show the patient: counted from when the triage entered the
// queue, or from now if that time has already passed.
export function nextReviewBy(since, now = new Date()) {
  const eta = expectedResponseBy(since)
  return eta > now ? eta : expectedResponseBy(now)
}

// ---------------------------------------------------------------------------
// Round-robin assignment: the verified, on-call, eligible clinician who was
// assigned least recently (never-assigned first). The claim is a guarded
// update, so two triages arriving at the same moment cannot both pick the
// same clinician. Pass a transaction client to run it inside a transaction.
// Returns a professional id, or null when nobody is on call.
// ---------------------------------------------------------------------------

export async function assignClinician(client) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await client.professional.findFirst({
      where: {
        verified: true,
        deletedAt: null,
        onCallForTriage: true,
        type: { in: TRIAGE_CLINICIAN_TYPES },
        agreementVersion: CURRENT_AGREEMENT_VERSION,
        agreementAcceptedAt: { not: null },
      },
      orderBy: [{ lastTriageAssignedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      select: { id: true, lastTriageAssignedAt: true },
    })
    if (!candidate) return null

    const claimed = await client.professional.updateMany({
      where: { id: candidate.id, lastTriageAssignedAt: candidate.lastTriageAssignedAt },
      data: { lastTriageAssignedAt: new Date() },
    })
    if (claimed.count === 1) return candidate.id
  }
  return null
}

// Everything the DHA-style registration needs before a patient is seen.
// National ID is optional (students and young people often have none).
export function registrationComplete(user) {
  return Boolean(
    user.phone &&
      user.dateOfBirth &&
      user.sex &&
      user.county &&
      user.nextOfKinName &&
      user.nextOfKinPhone &&
      user.nextOfKinRelationship
  )
}
