import { Router } from 'express'
import { z } from 'zod'
import { db } from '../lib/db.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'

// Workspaces: every query here goes through db(req.ctx), so records are
// only ever read, written or matched within the caller's own scope
// (Mindora Care or one institution's workspace), and new records are
// stamped with it.
export const messageRouter = Router()

// Everything here is the therapy conversation between a patient and a
// professional they have an appointment with. Triage chat messages carry a
// triageId and live in their own thread (see routes/v1/triage.js), so they
// are left out of every query below with triageId: null.

// Confirms a real booked appointment (any status, past or upcoming) exists
// between this user and professional — the gate that keeps messaging
// restricted to pairs who actually have a care relationship, rather than
// open messaging between any patient and any professional.
async function hasAppointmentTogether(ctx, userId, professionalId) {
  const appointment = await db(ctx).appointment.findFirst({
    where: { userId, professionalId },
  })
  return Boolean(appointment)
}

// Conversation list — for a patient, one row per professional they've
// messaged or booked with; for a professional, one row per patient.
// Built from appointments (the source of truth for who's allowed to talk
// to whom) rather than from messages, so a conversation still shows up
// even before the first message is sent.
messageRouter.get('/conversations', requireAuth, requireRole('user', 'professional'), async (req, res) => {
  if (req.auth.role === 'user') {
    const appointments = await db(req.ctx).appointment.findMany({
      where: { userId: req.auth.id },
      select: { professionalId: true, professional: { select: { id: true, fullName: true } } },
      distinct: ['professionalId'],
    })

    const conversations = await Promise.all(
      appointments.map(async (a) => {
        const [lastMessage, unreadCount] = await Promise.all([
          db(req.ctx).message.findFirst({
            where: { userId: req.auth.id, professionalId: a.professionalId, triageId: null },
            orderBy: { createdAt: 'desc' },
          }),
          db(req.ctx).message.count({
            where: {
              userId: req.auth.id,
              professionalId: a.professionalId,
              triageId: null,
              senderRole: 'professional',
              readAt: null,
            },
          }),
        ])
        return {
          professionalId: a.professional.id,
          professionalName: a.professional.fullName,
          lastMessage: lastMessage?.content ?? null,
          lastMessageAt: lastMessage?.createdAt ?? null,
          unreadCount,
        }
      })
    )

    return res.json(conversations)
  }

  const appointments = await db(req.ctx).appointment.findMany({
    where: { professionalId: req.auth.id },
    select: { userId: true, user: { select: { id: true, fullName: true } } },
    distinct: ['userId'],
  })

  const conversations = await Promise.all(
    appointments.map(async (a) => {
      const [lastMessage, unreadCount] = await Promise.all([
        db(req.ctx).message.findFirst({
          where: { userId: a.userId, professionalId: req.auth.id, triageId: null },
          orderBy: { createdAt: 'desc' },
        }),
        db(req.ctx).message.count({
          where: {
            userId: a.userId,
            professionalId: req.auth.id,
            triageId: null,
            senderRole: 'user',
            readAt: null,
          },
        }),
      ])
      return {
        userId: a.user.id,
        userName: a.user.fullName,
        lastMessage: lastMessage?.content ?? null,
        lastMessageAt: lastMessage?.createdAt ?? null,
        unreadCount,
      }
    })
  )

  res.json(conversations)
})

// Messages in one conversation, oldest first. Also marks any messages sent
// *to* the caller as read, since fetching a thread means the caller is now
// looking at it.
messageRouter.get(
  '/thread/:otherPartyId',
  requireAuth,
  requireRole('user', 'professional'),
  async (req, res) => {
    const { otherPartyId } = req.params
    const userId = req.auth.role === 'user' ? req.auth.id : otherPartyId
    const professionalId = req.auth.role === 'professional' ? req.auth.id : otherPartyId

    const allowed = await hasAppointmentTogether(req.ctx, userId, professionalId)
    if (!allowed) return res.status(403).json({ error: 'No shared appointment with this person.' })

    const messages = await db(req.ctx).message.findMany({
      where: { userId, professionalId, triageId: null },
      orderBy: { createdAt: 'asc' },
    })

    const incomingSenderRole = req.auth.role === 'user' ? 'professional' : 'user'
    await db(req.ctx).message.updateMany({
      where: { userId, professionalId, triageId: null, senderRole: incomingSenderRole, readAt: null },
      data: { readAt: new Date() },
    })

    res.json(messages)
  }
)

const sendSchema = z.object({
  otherPartyId: z.string().uuid(),
  content: z.string().min(1).max(2000),
})

messageRouter.post('/', requireAuth, requireRole('user', 'professional'), async (req, res) => {
  const parsed = sendSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { otherPartyId, content } = parsed.data
  const userId = req.auth.role === 'user' ? req.auth.id : otherPartyId
  const professionalId = req.auth.role === 'professional' ? req.auth.id : otherPartyId

  const allowed = await hasAppointmentTogether(req.ctx, userId, professionalId)
  if (!allowed) return res.status(403).json({ error: 'No shared appointment with this person.' })

  const message = await db(req.ctx).message.create({
    data: { userId, professionalId, senderRole: req.auth.role, content },
  })

  await audit({
    actorType: req.auth.role,
    actorId: req.auth.id,
    action: 'message.send',
    resourceType: 'message',
    resourceId: message.id,
  })

  res.status(201).json(message)
})
