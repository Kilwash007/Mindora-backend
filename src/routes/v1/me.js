import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireRole } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { wrap, HttpError } from '../../lib/wrap.js'
import { normalizeKenyanPhone } from '../../lib/mpesa.js'
import { registrationComplete } from '../../lib/triage.js'

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
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`)
      return !Number.isNaN(d.getTime()) && d < new Date() && d.getUTCFullYear() >= 1900
    }, 'Please enter a valid date of birth.')
    .optional(),
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
  if (dateOfBirth) data.dateOfBirth = new Date(`${dateOfBirth}T00:00:00Z`)

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
