import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireRole } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { wrap, HttpError } from '../../lib/wrap.js'
import { normalizeKenyanPhone } from '../../lib/mpesa.js'
import { registrationComplete } from '../../lib/triage.js'
import { dateOfBirthField, dobToDate, isUnder18, UNDER_18_ACCOUNT } from '../../lib/age.js'

export const meRouter = Router()

const REGISTRATION_SELECT = {
  phone: true,
  dateOfBirth: true,
  sex: true,
  county: true,
  nationalIdNumber: true,
  nextOfKinName: true,
  nextOfKinPhone: true,
  nextOfKinRelationship: true,
}

// The patient's own registration details (the fields a digital health
// record needs). Collected at triage, not at sign-up.
meRouter.get('/registration', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth.id }, select: REGISTRATION_SELECT })
  if (!user) throw new HttpError(404, 'Account not found.')
  res.json({ ...user, complete: registrationComplete(user) })
}))

const kenyanPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const normalized = normalizeKenyanPhone(v)
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Please enter a valid Kenyan phone number.' })
      return z.NEVER
    }
    return normalized
  })

const registrationSchema = z.object({
  phone: kenyanPhone.optional(),
  dateOfBirth: dateOfBirthField.optional(),
  sex: z.enum(['FEMALE', 'MALE', 'INTERSEX', 'PREFER_NOT_TO_SAY']).optional(),
  county: z.string().trim().min(2).max(60).optional(),
  nationalIdNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{5,20}$/, 'Please enter a valid ID number.')
    .nullable()
    .optional(),
  nextOfKinName: z.string().trim().min(2).max(120).optional(),
  nextOfKinPhone: kenyanPhone.optional(),
  nextOfKinRelationship: z.string().trim().min(2).max(60).optional(),
})

meRouter.patch('/registration', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const parsed = registrationSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  if (Object.keys(parsed.data).length === 0) throw new HttpError(400, 'Nothing to update.')

  const { dateOfBirth, ...rest } = parsed.data
  const data = { ...rest }

  if (dateOfBirth) {
    const current = await prisma.user.findUnique({ where: { id: req.auth.id }, select: { dateOfBirth: true } })
    if (!current) throw new HttpError(404, 'Account not found.')
    const saved = current.dateOfBirth ? current.dateOfBirth.toISOString().slice(0, 10) : null

    // Once saved, the date of birth can't be changed here (the form sends it
    // back unchanged with every save, which is fine). This stops an age
    // check being got round by editing it afterwards.
    if (saved && saved !== dateOfBirth) {
      return res.status(409).json({
        error: 'Your date of birth is already saved. To correct it, contact Mindora support.',
        code: 'DOB_LOCKED',
      })
    }

    // Accounts made before date of birth was asked at sign-up give it here,
    // at triage. Under 18 stops here and nothing is saved.
    if (isUnder18(dateOfBirth)) {
      await audit({
        actorType: 'user',
        actorId: req.auth.id,
        action: 'registration.under_18_blocked',
        resourceType: 'user',
        resourceId: req.auth.id,
      })
      return res.status(403).json(UNDER_18_ACCOUNT)
    }

    if (!saved) data.dateOfBirth = dobToDate(dateOfBirth)
  }

  const user = await prisma.user.update({
    where: { id: req.auth.id },
    data,
    select: REGISTRATION_SELECT,
  })

  // Field names only, never the values.
  await audit({
    actorType: 'user',
    actorId: req.auth.id,
    action: 'registration.update',
    resourceType: 'user',
    resourceId: req.auth.id,
    metadata: { fields: Object.keys(parsed.data) },
  })

  res.json({ ...user, complete: registrationComplete(user) })
}))
