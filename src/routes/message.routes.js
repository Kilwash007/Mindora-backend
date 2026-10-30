import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'

export const messageRouter = Router()

// Everything here is the therapy conversation between a patient and a
// professional they have an appointment with. Triage chat messages carry a
// triageId and live in their own thread (see routes/v1/triage.js), so they
// are left out of every query below with triageId: null.

// Confirms a real booked appointment (any status, past or upcoming) exists
// between this user and professional — the gate that keeps messaging
// restricted to pairs who actually have a care relationship, rather than
// open messaging between any patient and any professional.
async function hasAppointmentTogether(userId, professionalId) {
  const appointment = await prisma.appointment.findFirst({
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
    const appointments = await prisma.appointment.findMany({
      where: { userId: req.auth.id },
      select: { professionalId: true, professional: { select: { id: true, fullName: true } } },
      distinct: ['professionalId'],
    })

    const conversations = await Promise.all(
      appointments.map(async (a) => {
        const [lastMessage, unreadCount] = await Promise.all([
          prisma.message.findFirst({
            where: { userId: req.auth.id, professionalId: a.professionalId, triageId: null },
            orderBy: { createdAt: 'desc' },
          }),
          prisma.message.count({
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

  const appointments = await prisma.appointment.findMany({
    where: { professionalId: req.auth.id },
    select: { userId: true, user: { select: { id: true, fullName: true } } },
    distinct: ['userId'],
  })

  const conversations = await Promise.all(
    appointments.map(async (a) => {
      const [lastMessage, unreadCount] = await Promise.all([
        prisma.message.findFirst({
          where: { userId: a.userId, professionalId: req.auth.id, triageId: null },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.message.count({
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

    const allowed = await hasAppointmentTogether(userId, professionalId)
    if (!allowed) return res.status(403).json({ error: 'No shared appointment with this person.' })

    const messages = await prisma.message.findMany({
      where: { userId, professionalId, triageId: null },
      orderBy: { createdAt: 'asc' },
    })

    const incomingSenderRole = req.auth.role === 'user' ? 'professional' : 'user'
    await prisma.message.updateMany({
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

  const allowed = await hasAppointmentTogether(userId, professionalId)
  if (!allowed) return res.status(403).json({ error: 'No shared appointment with this person.' })

  const message = await prisma.message.create({
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
