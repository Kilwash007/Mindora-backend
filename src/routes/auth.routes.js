import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { hashPassword, verifyPassword } from '../lib/auth.js'
import { issueSession, refreshSession, revokeRefreshToken, revokeAllSessions } from '../lib/session.js'
import { loginLimiter, registerLimiter, otpVerifyLimiter } from '../middleware/rateLimit.js'
import { generateOtpCode, hashOtpCode, otpExpiryDate } from '../lib/otp.js'
import { sendOtpEmail } from '../lib/email.js'
import { requireAuth } from '../middleware/auth.js'
import { CURRENT_CONSENT_VERSION } from '../lib/consent.js'
import { PROFESSIONAL_TYPES } from '../lib/professionalTypes.js'

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

// TEMPORARY, staging-only: when DISABLE_OTP=true on the server, user and
// professional logins accept the fixed code 000000 instead of an emailed
// code. Admin logins always need the real emailed code. Never set this on
// production.
const OTP_DISABLED = process.env.DISABLE_OTP === 'true'
if (OTP_DISABLED) {
  console.warn('[auth] DISABLE_OTP is on: user/professional logins accept the fixed test code 000000')
}

async function issueOtp(email, role) {
  const useTestCode = OTP_DISABLED && role !== 'admin'
  const code = useTestCode ? '000000' : generateOtpCode()
  await prisma.loginOtp.create({
    data: {
      email,
      role,
      codeHash: hashOtpCode(code),
      expiresAt: otpExpiryDate(),
    },
  })
  if (!useTestCode) await sendOtpEmail(email, code)
}

// --- User ---

authRouter.post('/user/register', registerLimiter, async (req, res) => {
  const parsed = userRegisterSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { fullName, email, password } = parsed.data
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' })

  const user = await prisma.user.create({
    data: {
      fullName,
      email,
      passwordHash: await hashPassword(password),
      consentAcceptedAt: new Date(),
      consentVersion: CURRENT_CONSENT_VERSION,
    },
  })

  const session = await issueSession({ id: user.id, role: 'user' })
  res.status(201).json({ ...session, user: { id: user.id, fullName: user.fullName, email: user.email } })
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

// --- Session management ---

const refreshSchema = z.object({ refreshToken: z.string().min(1) })

authRouter.post('/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const session = await refreshSession(parsed.data.refreshToken)
  if (!session) return res.status(401).json({ error: 'Session expired. Please log in again.' })

  res.json(session)
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