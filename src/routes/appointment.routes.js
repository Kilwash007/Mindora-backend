import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole, requireAgreement } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { PUBLIC_PROFESSIONAL_SELECT } from '../lib/safeSelects.js'
import { holdExpiresAt } from '../lib/holds.js'

export const appointmentRouter = Router()

// Booking has moved to POST /api/v1/appointments. Sessions are now booked
// after a free screening and a triage, at a fixed price, so this old route
// no longer books anything. It answers with a clear message so a page that
// has not been refreshed knows what to do.
appointmentRouter.post('/', requireAuth, requireRole('user'), (_req, res) => {
  res.status(410).json({
    error:
      'Booking has changed. Please refresh the page: sessions are now booked after a free screening and a triage.',
    code: 'BOOKING_MOVED',
  })
})

const statusSchema = z.object({
  status: z.enum(['COMPLETED', 'CANCELLED', 'NO_SHOW']),
})

appointmentRouter.patch(
  '/:id/status',
  requireAuth,
  requireRole('professional'),
  requireAgreement,
  async (req, res) => {
    const parsed = statusSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id } })
    if (!appointment || appointment.professionalId !== req.auth.id) {
      return res.status(404).json({ error: 'Appointment not found.' })
    }

    const updated = await prisma.appointment.update({
      where: { id: req.params.id },
      data: { status: parsed.data.status },
    })

    await audit({
      actorType: 'professional',
      actorId: req.auth.id,
      action: 'appointment.status_update',
      resourceType: 'appointment',
      resourceId: appointment.id,
      metadata: { status: parsed.data.status },
    })

    res.json(updated)
  }
)

// Patient's own appointments — not gated by the professional agreement.
// The professional comes back with public fields only. An unpaid session
// booked the new way also says when its slot will be released.
appointmentRouter.get('/mine', requireAuth, requireRole('user'), async (req, res) => {
  const appointments = await prisma.appointment.findMany({
    where: { userId: req.auth.id },
    include: { professional: { select: PUBLIC_PROFESSIONAL_SELECT } },
    orderBy: { scheduledFor: 'desc' },
  })
  res.json(
    appointments.map((a) => ({
      ...a,
      holdExpiresAt:
        a.serviceType && a.status === 'SCHEDULED' && a.feeKes - a.institutionCoveredKes > 0
          ? holdExpiresAt(a.createdAt)
          : null,
    }))
  )
})

appointmentRouter.get('/', requireAuth, requireRole('professional'), requireAgreement, async (req, res) => {
  const appointments = await prisma.appointment.findMany({
    where: { professionalId: req.auth.id },
    orderBy: { scheduledFor: 'asc' },
  })

  const now = new Date()
  res.json({
    upcoming: appointments.filter((a) => a.scheduledFor >= now),
    past: appointments.filter((a) => a.scheduledFor < now),
  })
})
