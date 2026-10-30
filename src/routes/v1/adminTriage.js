import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireAdminRole } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { wrap } from '../../lib/wrap.js'
import { TRIAGE_CLINICIAN_TYPES } from '../../lib/triage.js'

export const adminTriageRouter = Router()

const DAY_MS = 24 * 60 * 60 * 1000

// A picture of the triage queue for the people running the platform: who is
// on call, what is waiting, what has gone overdue, and payments that arrived
// after a slot was released. It deliberately has NO patient names, emails or
// clinical detail: a triage is a health record, and an operations view does
// not need to read it. Patient ids appear only where money needs sorting out.
adminTriageRouter.get(
  '/',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'CLINICAL_SAFETY_REVIEWER'),
  wrap(async (req, res) => {
    const now = new Date()

    const [onCall, awaitingPayment, queued, inProgress, completedLastWeek, unassigned, escalated, waiting, latePaid] =
      await Promise.all([
        prisma.professional.findMany({
          where: { onCallForTriage: true, verified: true, deletedAt: null, type: { in: TRIAGE_CLINICIAN_TYPES } },
          select: { id: true, fullName: true, type: true },
          orderBy: { fullName: 'asc' },
        }),
        prisma.triage.count({ where: { status: 'AWAITING_PAYMENT' } }),
        prisma.triage.count({ where: { status: 'QUEUED' } }),
        prisma.triage.count({ where: { status: 'IN_PROGRESS' } }),
        prisma.triage.count({ where: { status: 'COMPLETED', completedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } } }),
        prisma.triage.count({ where: { status: 'QUEUED', clinicianId: null } }),
        prisma.triage.count({ where: { status: 'QUEUED', escalatedAt: { not: null } } }),
        prisma.triage.findMany({
          where: { status: 'QUEUED' },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: {
            id: true,
            isFree: true,
            urgency: true,
            createdAt: true,
            reminderSentAt: true,
            escalatedAt: true,
            sponsoringInstitutionId: true,
            clinician: { select: { fullName: true } },
            payment: { select: { paidAt: true } },
          },
        }),
        prisma.payment.findMany({
          where: {
            status: 'PAID',
            paidAt: { gte: new Date(now.getTime() - 30 * DAY_MS) },
            appointment: { is: { status: 'CANCELLED' } },
          },
          orderBy: { paidAt: 'desc' },
          take: 50,
          select: {
            id: true,
            amountKes: true,
            mpesaReceiptNumber: true,
            paidAt: true,
            appointment: {
              select: { id: true, userId: true, scheduledFor: true, professional: { select: { fullName: true } } },
            },
          },
        }),
      ])

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.triage.view',
      resourceType: 'triage',
    })

    res.json({
      generatedAt: now,
      onCall: { count: onCall.length, clinicians: onCall },
      counts: { awaitingPayment, queued, inProgress, completedLastWeek, unassigned, escalated },
      waiting: waiting.map((t) => {
        const queuedAt = t.payment?.paidAt ?? t.createdAt
        return {
          id: t.id,
          urgent: t.isFree || t.urgency === 'URGENT',
          covered: Boolean(t.sponsoringInstitutionId),
          waitingMinutes: Math.max(0, Math.round((now.getTime() - new Date(queuedAt).getTime()) / 60000)),
          assignedTo: t.clinician?.fullName ?? null,
          reminded: Boolean(t.reminderSentAt),
          released: Boolean(t.escalatedAt),
        }
      }),
      latePaid: latePaid.map((p) => ({
        paymentId: p.id,
        amountKes: p.amountKes,
        mpesaReceiptNumber: p.mpesaReceiptNumber,
        paidAt: p.paidAt,
        appointmentId: p.appointment.id,
        scheduledFor: p.appointment.scheduledFor,
        professionalName: p.appointment.professional.fullName,
        userId: p.appointment.userId,
      })),
    })
  })
)
