import crypto from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { hashPassword, verifyPassword } from '../lib/auth.js'
import { issueSession, refreshSession, revokeRefreshToken, revokeAllSessions } from '../lib/session.js'
import {
  loginLimiter,
  registerLimiter,
  otpVerifyLimiter,
  resetRequestLimiter,
  resetVerifyLimiter,
} from '../middleware/rateLimit.js'
import { generateOtpCode, hashOtpCode, otpExpiryDate } from '../lib/otp.js'
import { sendOtpEmail, sendPasswordResetEmail } from '../lib/email.js'
import { requireAuth } from '../middleware/auth.js'
import { CURRENT_CONSENT_VERSION } from '../lib/consent.js'
import { PROFESSIONAL_TYPES } from '../lib/professionalTypes.js'
import { findEnrollableInstitution } from '../lib/enroll.js'

export const authRouter = Router()

const registerSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
})

// Patients must explicitly consent — z.literal(true) rejects anything but
// an actual, deliberate "true" (missing, false, or omitted all fail).
const userRegisterSchema = registerSchema.extend({
  consent: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the privacy consent to create an account.' }),
  }),
  // An optional pilot or promo code that links the new account to its programme.
  enrollmentCode: z.string().trim().max(40).optional(),
})

// Professionals choose their professional type at sign-up. It defaults to
// PSYCHOLOGIST only so older sign-up forms that don't send a type keep
// working; the type is checked against the allowed list and confirmed
// during KYC verification before the professional is ever listed.
const professionalRegisterSchema = registerSchema.extend({
  type: z.enum(PROFESSIONAL_TYPES).default('PSYCHOLOGIST'),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// Every login, for every role, gets a freshly generated code sent to the
// account's email address. There is no fixed or test code path.
async function issueOtp(email, role) {
  const code = generateOtpCode()
  await prisma.loginOtp.create({
    data: {
      email,
      role,
      codeHash: hashOtpCode(code),
      expiresAt: otpExpiryDate(),
    },
  })
  await sendOtpEmail(email, code)
}

// --- User ---

authRouter.post('/user/register', registerLimiter, async (req, res) => {
  const parsed = userRegisterSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { fullName, email, password, enrollmentCode } = parsed.data
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' })

  // A wrong or full code is refused before the account is created, so the
  // person can correct it or leave it blank rather than join half-way.
  let institution = null
  if (enrollmentCode) {
    const found = await findEnrollableInstitution(enrollmentCode)
    if (found.error) return res.status(found.status).json({ error: found.error, code: 'CODE_INVALID' })
    institution = found.institution
  }

  const user = await prisma.user.create({
    data: {
      fullName,
      email,
      passwordHash: await hashPassword(password),
      consentAcceptedAt: new Date(),
      consentVersion: CURRENT_CONSENT_VERSION,
      institutionId: institution?.id ?? null,
    },
  })

  const session = await issueSession({ id: user.id, role: 'user' })
  res.status(201).json({
    ...session,
    user: { id: user.id, fullName: user.fullName, email: user.email },
    institution: institution
      ? { name: institution.name, coversTriage: institution.coversTriage, requiresStudentProof: institution.requiresStudentProof }
      : null,
  })
})

authRouter.post('/user/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { email, password } = parsed.data
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password.' })
  }

  await issueOtp(email, 'user')
  res.json({ otpRequired: true, email })
})

// --- Professional ---

authRouter.post('/professional/register', registerLimiter, async (req, res) => {
  const parsed = professionalRegisterSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { fullName, email, password, type } = parsed.data
  const existing = await prisma.professional.findUnique({ where: { email } })
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' })

  const professional = await prisma.professional.create({
    data: {
      fullName,
      email,
      passwordHash: await hashPassword(password),
      type,
      verified: false,
    },
  })

  const session = await issueSession({ id: professional.id, role: 'professional' })
  res.status(201).json({
    ...session,
    professional: { id: professional.id, fullName: professional.fullName, verified: professional.verified },
  })
})

authRouter.post('/professional/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { email, password } = parsed.data
  const professional = await prisma.professional.findUnique({ where: { email } })
  if (!professional || !(await verifyPassword(password, professional.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password.' })
  }

  await issueOtp(email, 'professional')
  res.json({ otpRequired: true, email })
})

// --- Admin ---

authRouter.post('/admin/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { email, password } = parsed.data
  const admin = await prisma.admin.findUnique({ where: { email } })
  if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password.' })
  }

  await issueOtp(email, 'admin')
  res.json({ otpRequired: true, email })
})

// --- Shared OTP verification ---

const verifyOtpSchema = z.object({
  role: z.enum(['user', 'professional', 'admin']),
  email: z.string().email(),
  code: z.string().length(6),
})

authRouter.post('/verify-otp', otpVerifyLimiter, async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { role, email, code } = parsed.data

  const otp = await prisma.loginOtp.findFirst({
    where: { email, role, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })

  if (!otp || otp.codeHash !== hashOtpCode(code)) {
    return res.status(401).json({ error: 'Invalid or expired code.' })
  }

  await prisma.loginOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } })

  if (role === 'user') {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return res.status(404).json({ error: 'Account not found.' })
    const session = await issueSession({ id: user.id, role: 'user' })
    return res.json({ ...session, user: { id: user.id, fullName: user.fullName, email: user.email } })
  }

  if (role === 'professional') {
    const professional = await prisma.professional.findUnique({ where: { email } })
    if (!professional) return res.status(404).json({ error: 'Account not found.' })
    const session = await issueSession({ id: professional.id, role: 'professional' })
    return res.json({
      ...session,
      professional: { id: professional.id, fullName: professional.fullName, verified: professional.verified },
    })
  }

  const admin = await prisma.admin.findUnique({ where: { email } })
  if (!admin) return res.status(404).json({ error: 'Account not found.' })
  const session = await issueSession({ id: admin.id, role: 'admin', adminRole: admin.role })
  res.json({ ...session, admin: { id: admin.id, fullName: admin.fullName, role: admin.role } })
})

// --- Password reset (users and professionals only) ---
//
// Admin passwords are reset by another platform admin, never by email.
// Reset codes live in their own table so one can never be submitted to
// /verify-otp and used to sign in.

const RESET_MAX_ATTEMPTS = 5
const RESET_COOLDOWN_MS = 60 * 1000

const forgotSchema = z.object({
  role: z.enum(['user', 'professional']),
  email: z.string().email(),
})

const resetSchema = z.object({
  role: z.enum(['user', 'professional']),
  email: z.string().email(),
  code: z.string().length(6),
  newPassword: z.string().min(8),
})

function accountTable(client, role) {
  return role === 'user' ? client.user : client.professional
}

authRouter.post('/forgot-password', resetRequestLimiter, async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { role, email } = parsed.data

  // Same answer, sent straight away, whether or not the account exists, so
  // the response (and its timing) never reveals which emails are registered.
  res.json({ ok: true })

  try {
    const account = await accountTable(prisma, role).findUnique({ where: { email }, select: { id: true } })
    if (!account) return

    // One code per minute per account, so the endpoint can't flood an inbox.
    const recent = await prisma.passwordReset.findFirst({
      where: { email, role, createdAt: { gt: new Date(Date.now() - RESET_COOLDOWN_MS) } },
    })
    if (recent) return

    // A new code replaces any earlier unused one.
    await prisma.passwordReset.updateMany({
      where: { email, role, consumedAt: null },
      data: { consumedAt: new Date() },
    })

    const code = generateOtpCode()
    await prisma.passwordReset.create({
      data: { email, role, codeHash: hashOtpCode(code), expiresAt: otpExpiryDate() },
    })
    await sendPasswordResetEmail(email, code)
  } catch (err) {
    console.error('[auth] password reset request failed:', err.message)
  }
})

authRouter.post('/reset-password', resetVerifyLimiter, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { role, email, code, newPassword } = parsed.data
  const invalid = () => res.status(401).json({ error: 'Invalid or expired code.' })

  const reset = await prisma.passwordReset.findFirst({
    where: { email, role, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (!reset || reset.attempts >= RESET_MAX_ATTEMPTS) return invalid()

  const given = Buffer.from(hashOtpCode(code), 'hex')
  const expected = Buffer.from(reset.codeHash, 'hex')
  const matches = given.length === expected.length && crypto.timingSafeEqual(given, expected)

  if (!matches) {
    await prisma.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } })
    return invalid()
  }

  const account = await accountTable(prisma, role).findUnique({ where: { email }, select: { id: true } })
  if (!account) return invalid()

  const passwordHash = await hashPassword(newPassword)

  // Claim the code and change the password in one transaction, so two
  // requests at the same moment cannot both use the same code.
  const changed = await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordReset.updateMany({
      where: { id: reset.id, consumedAt: null },
      data: { consumedAt: new Date() },
    })
    if (claimed.count === 0) return false

    await accountTable(tx, role).update({ where: { id: account.id }, data: { passwordHash } })
    // Any login code that was already on its way is no longer valid either.
    await tx.loginOtp.updateMany({ where: { email, role, consumedAt: null }, data: { consumedAt: new Date() } })
    return true
  })
  if (!changed) return invalid()

  // Everyone signed in as this account is signed out.
  await revokeAllSessions(role, account.id)
  res.json({ ok: true })
})

// --- Session management ---

const refreshSchema = z.object({ refreshToken: z.string().min(1) })

authRouter.post('/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body)
  if (parsed.success) {
    const session = await refreshSession(parsed.data.refreshToken)
    if (!session) return res.status(401).json({ error: 'Session expired. Please log in again.' })
    return res.json(session)
  }
  return res.status(400).json({ error: parsed.error.flatten() })
})

authRouter.post('/logout', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body)
  if (parsed.success) {
    await revokeRefreshToken(parsed.data.refreshToken)
  }
  res.json({ loggedOut: true })
})

authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await revokeAllSessions(req.auth.role, req.auth.id)
  res.json({ loggedOut: true })
})
