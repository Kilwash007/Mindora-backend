import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db.js'
import { requireAuth, requireRole, requireAgreement } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'

// Workspaces: every query here goes through db(req.ctx), so records are
// only ever read, written or matched within the caller's own scope
// (Mindora Care or one institution's workspace), and new records are
// stamped with it.
export const clientRouter = Router()

async function getClientUserIds(req, professionalId) {
  const [referrals, appointments] = await Promise.all([
    db(req.ctx).referral.findMany({
      where: { professionalId, status: 'ACCEPTED' },
      select: { userId: true },
    }),
    db(req.ctx).appointment.findMany({
      where: { professionalId },
      select: { userId: true },
    }),
  ])
  return Array.from(new Set([...referrals.map((r) => r.userId), ...appointments.map((a) => a.userId)]))
}

clientRouter.get('/', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const userIds = await getClientUserIds(req, req.auth.id)

  const clients = await Promise.all(
    userIds.map(async (userId) => {
      const latestCheckIn = await db(req.ctx).checkIn.findFirst({
        where: { userId },
        orderBy: { completedAt: 'desc' },
      })
      return {
        userId,
        latestRiskLevel: latestCheckIn?.riskLevel ?? null,
        lastCheckInAt: latestCheckIn?.completedAt ?? null,
      }
    })
  )

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: 'clients.list',
    resourceType: 'client',
  })

  res.json(clients)
})

clientRouter.get('/:userId', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const { userId } = req.params
  const clientIds = await getClientUserIds(req, req.auth.id)

  if (!clientIds.includes(userId)) {
    return res.status(404).json({ error: 'Client not found.' })
  }

  const [checkIns, appointments, notes] = await Promise.all([
    db(req.ctx).checkIn.findMany({
      where: { userId },
      orderBy: { completedAt: 'asc' },
      include: { answers: true },
    }),
    db(req.ctx).appointment.findMany({
      where: { userId, professionalId: req.auth.id },
      orderBy: { scheduledFor: 'desc' },
    }),
    db(req.ctx).clinicalNote.findMany({
      where: { userId, professionalId: req.auth.id },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: 'client.view',
    resourceType: 'client',
    resourceId: userId,
  })

  res.json({ userId, checkIns, appointments, notes })
})

const noteSchema = z.object({ content: z.string().min(1) })

clientRouter.post('/:userId/notes', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const { userId } = req.params
  const clientIds = await getClientUserIds(req, req.auth.id)
  if (!clientIds.includes(userId)) {
    return res.status(404).json({ error: 'Client not found.' })
  }

  const parsed = noteSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const note = await db(req.ctx).clinicalNote.create({
    data: { professionalId: req.auth.id, userId, content: parsed.data.content },
  })

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: 'clinical_note.create',
    resourceType: 'clinical_note',
    resourceId: note.id,
  })

  res.status(201).json(note)
})
