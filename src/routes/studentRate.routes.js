import { Router } from 'express'
import multer from 'multer'
import crypto from 'crypto'
import { z } from 'zod'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole, requireAdminRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { notifyProofDecision } from '../lib/proofReview.js'

export const studentRateRouter = Router()

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// Same R2 setup as document.routes.js, for the same reason — KYC-grade
// documents (here, a government ID proving age) need encrypted, durable
// storage, not local disk.
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})
const BUCKET = process.env.R2_BUCKET_NAME

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Only PDF, JPG, or PNG files are allowed.'))
  },
})

// ---------------------------------------------------------------------------
// Patient: submit and check status
// ---------------------------------------------------------------------------

const submitSchema = z.object({
  method: z.enum(['STUDENT_EMAIL', 'YOUNG_ADULT_ID']),
  evidence: z.string().min(1).optional(), // university email, for STUDENT_EMAIL
})

// Both verification methods go through human review, not auto-approval —
// a university email can be spoofed and an ID can be borrowed, and the
// cost of a wrong auto-approval (a discounted rate meant for students
// going to someone it wasn't meant for) is worth a person's judgment.
studentRateRouter.post('/verify', requireAuth, requireRole('user'), upload.single('file'), wrap(async (req, res) => {
  const parsed = submitSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { method } = parsed.data

  const existing = await prisma.studentRateVerification.findFirst({
    where: { userId: req.auth.id, status: { in: ['PENDING', 'APPROVED'] } },
  })
  if (existing) {
    return res.status(409).json({
      error:
        existing.status === 'APPROVED'
          ? 'You are already verified for the Student Rate.'
          : 'You already have a verification request awaiting review.',
    })
  }

  let evidence
  let filePath = null

  if (method === 'STUDENT_EMAIL') {
    const emailCheck = z.string().email().safeParse(parsed.data.evidence)
    if (!emailCheck.success) {
      return res.status(400).json({ error: 'Please enter a valid university email address.' })
    }
    evidence = emailCheck.data
  } else {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a photo or scan of your ID.' })
    }
    const ext = req.file.originalname.includes('.')
      ? req.file.originalname.slice(req.file.originalname.lastIndexOf('.'))
      : ''
    const objectKey = `student-rate/${crypto.randomUUID()}${ext}`
    await r2.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: objectKey, Body: req.file.buffer, ContentType: req.file.mimetype })
    )
    filePath = objectKey
    evidence = 'ID document uploaded — see filePath' // evidence is required non-null in schema; this keeps it self-explanatory in admin views
  }

  const verification = await prisma.studentRateVerification.create({
    data: { userId: req.auth.id, method, evidence, filePath },
  })

  await audit({
    actorType: 'user',
    actorId: req.auth.id,
    action: 'student_rate.verify.submit',
    resourceType: 'student_rate_verification',
    resourceId: verification.id,
    metadata: { method },
  })

  res.status(201).json({ id: verification.id, status: verification.status })
}))

studentRateRouter.get('/status', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth.id }, select: { studentRateEligible: true } })
  const latest = await prisma.studentRateVerification.findFirst({
    where: { userId: req.auth.id },
    orderBy: { createdAt: 'desc' },
  })

  res.json({
    eligible: user?.studentRateEligible ?? false,
    latest: latest
      ? { id: latest.id, method: latest.method, status: latest.status, reviewNotes: latest.reviewNotes, createdAt: latest.createdAt }
      : null,
  })
}))

// ---------------------------------------------------------------------------
// Admin: review queue
// ---------------------------------------------------------------------------

studentRateRouter.get('/verifications', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const verifications = await prisma.studentRateVerification.findMany({
    include: { user: { select: { fullName: true, email: true, institution: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
  })

  res.json(
    verifications.map((v) => ({
      id: v.id,
      userId: v.userId,
      userFullName: v.user.fullName,
      userEmail: v.user.email,
      institutionName: v.user.institution?.name ?? null,
      method: v.method,
      evidence: v.evidence,
      hasFile: Boolean(v.filePath),
      status: v.status,
      reviewNotes: v.reviewNotes,
      createdAt: v.createdAt,
      reviewedAt: v.reviewedAt,
    }))
  )
}))

const reviewSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  reviewNotes: z.string().optional(),
})

studentRateRouter.patch('/verifications/:id/review', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const verification = await prisma.studentRateVerification.findUnique({ where: { id: req.params.id } })
  if (!verification) return res.status(404).json({ error: 'Verification not found.' })

  const updated = await prisma.studentRateVerification.update({
    where: { id: req.params.id },
    data: { status: parsed.data.status, reviewNotes: parsed.data.reviewNotes, reviewedAt: new Date() },
  })

  if (parsed.data.status === 'APPROVED') {
    await prisma.user.update({ where: { id: verification.userId }, data: { studentRateEligible: true } })
  }

  // Tell the person what was decided. Never blocks or undoes the review.
  notifyProofDecision(verification.id)

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: parsed.data.status === 'APPROVED' ? 'student_rate.verify.approve' : 'student_rate.verify.reject',
    resourceType: 'student_rate_verification',
    resourceId: verification.id,
  })

  res.json(updated)
}))

// Same access-control shape as document.routes.js's file endpoint: only
// the submitting patient or a PLATFORM_ADMIN reviewer can read the file.
studentRateRouter.get('/verifications/:id/file', requireAuth, wrap(async (req, res) => {
  const verification = await prisma.studentRateVerification.findUnique({ where: { id: req.params.id } })
  if (!verification || !verification.filePath) return res.status(404).json({ error: 'File not found.' })

  const isOwner = req.auth.role === 'user' && req.auth.id === verification.userId
  const isPlatformAdmin = req.auth.role === 'admin' && req.auth.adminRole === 'PLATFORM_ADMIN'
  if (!isOwner && !isPlatformAdmin) {
    return res.status(403).json({ error: 'You do not have access to this file.' })
  }

  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: verification.filePath }))
    await audit({
      actorType: req.auth.role,
      actorId: req.auth.id,
      action: 'student_rate.verify.view_file',
      resourceType: 'student_rate_verification',
      resourceId: verification.id,
    })
    res.setHeader('Content-Type', object.ContentType || 'application/octet-stream')
    object.Body.pipe(res)
  } catch (err) {
    console.error('R2 file fetch error:', err)
    res.status(404).json({ error: 'File not found in storage.' })
  }
}))