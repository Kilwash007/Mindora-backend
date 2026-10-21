import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole, requireAgreement } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'

export const referralRouter = Router()

// Statuses from which a professional may accept a referral.
const ACCEPTABLE = ['PENDING', 'MORE_INFO_REQUESTED']

// A professional's referral queue. Only returns referrals assigned to
// *this* professional — never the whole table.
referralRouter.get('/', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const referrals = await prisma.referral.findMany({
    where: { professionalId: req.auth.id },
    include: { flags: true, checkIn: true },
    orderBy: { createdAt: 'desc' },
  })

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: 'referral.list',
    resourceType: 'referral',
  })

  res.json(
    referrals.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      riskLevel: r.checkIn.riskLevel,
      flags: r.flags.map((f) => f.label),
      createdAt: r.createdAt,
    }))
  )
})

referralRouter.get('/:id', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const referral = await prisma.referral.findUnique({
    where: { id: req.params.id },
    include: { flags: true, checkIn: { include: { answers: true } } },
  })

  if (!referral || referral.professionalId !== req.auth.id) {
    return res.status(404).json({ error: 'Referral not found.' })
  }

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: 'referral.view',
    resourceType: 'referral',
    resourceId: referral.id,
  })

  res.json(referral)
})

referralRouter.post('/:id/accept', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const referral = await prisma.referral.findUnique({ where: { id: req.params.id } })
  if (!referral || referral.professionalId !== req.auth.id) {
    return res.status(404).json({ error: 'Referral not found.' })
  }

  // Already accepted: nothing to do. Answering success keeps a double-click
  // or a retry from showing an error right after a success.
  if (referral.status === 'ACCEPTED') {
    return res.json(referral)
  }

  // The status check and the update are one statement, so two requests at
  // the same moment cannot both change the referral.
  const result = await prisma.referral.updateMany({
    where: {
      id: referral.id,
      professionalId: req.auth.id,
      status: { in: ACCEPTABLE },
    },
    data: { status: 'ACCEPTED' },
  })

  if (result.count === 0) {
    // Something changed it between the read above and the update. Look again
    // so the answer reflects what the referral is now.
    const current = await prisma.referral.findUnique({ where: { id: referral.id } })
    if (current?.status === 'ACCEPTED') {
      return res.json(current)
    }
    return res.status(409).json({
      error: `This referral is ${String(current?.status ?? 'unavailable').toLowerCase().replace(/_/g, ' ')} and can no longer be accepted.`,
    })
  }

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: 'referral.accept',
    resourceType: 'referral',
    resourceId: referral.id,
  })

  const updated = await prisma.referral.findUnique({ where: { id: referral.id } })
  res.json(updated)
})