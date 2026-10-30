import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole, requireAdminRole } from '../middleware/auth.js'
import { audit } from '../lib/audit.js'
import { stripSecrets } from '../lib/safeSelects.js'

export const adminRouter = Router()

adminRouter.get(
  '/overview',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'CLINICAL_SAFETY_REVIEWER', 'SUPPORT'),
  async (req, res) => {
    const [totalUsers, assessmentsCompleted, referralsMade, professionalsOnNetwork] =
      await Promise.all([
        prisma.user.count(),
        prisma.checkIn.count(),
        prisma.referral.count(),
        prisma.professional.count({ where: { verified: true } }),
      ])

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.overview.view',
      resourceType: 'platform',
    })

    res.json({ totalUsers, assessmentsCompleted, referralsMade, professionalsOnNetwork })
  }
)

adminRouter.get(
  '/safety',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'CLINICAL_SAFETY_REVIEWER'),
  async (req, res) => {
    const riskCounts = await prisma.checkIn.groupBy({
      by: ['riskLevel'],
      _count: { riskLevel: true },
    })

    const counts = { LOW: 0, ELEVATED: 0, HIGH: 0, ACUTE: 0 }
    riskCounts.forEach((r) => {
      counts[r.riskLevel] = r._count.riskLevel
    })

    const alerts = await prisma.safetyAlert.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.safety.view',
      resourceType: 'platform',
    })

    res.json({
      counts,
      alerts: alerts.map((a) => ({
        id: a.id,
        level: a.riskLevel,
        note: a.note,
        userId: a.userId,
        referralId: a.referralId,
        createdAt: a.createdAt,
      })),
    })
  }
)

adminRouter.patch(
  '/safety/:id/resolve',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'CLINICAL_SAFETY_REVIEWER'),
  async (req, res) => {
    const alert = await prisma.safetyAlert.findUnique({ where: { id: req.params.id } })
    if (!alert) return res.status(404).json({ error: 'Alert not found.' })

    const updated = await prisma.safetyAlert.update({
      where: { id: req.params.id },
      data: { resolvedAt: new Date() },
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'safety_alert.resolve',
      resourceType: 'safety_alert',
      resourceId: alert.id,
    })

    res.json(updated)
  }
)

adminRouter.get(
  '/users',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'SUPPORT'),
  async (req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    })

    const withLatestRisk = await Promise.all(
      users.map(async (u) => {
        const [latestCheckIn, checkInCount] = await Promise.all([
          prisma.checkIn.findFirst({ where: { userId: u.id }, orderBy: { completedAt: 'desc' } }),
          prisma.checkIn.count({ where: { userId: u.id } }),
        ])
        return {
          id: u.id,
          fullName: u.fullName,
          email: u.email,
          createdAt: u.createdAt,
          checkInCount,
          latestRiskLevel: req.auth.adminRole === 'PLATFORM_ADMIN' ? latestCheckIn?.riskLevel ?? null : null,
        }
      })
    )

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.users.list',
      resourceType: 'user',
    })

    res.json(withLatestRisk)
  }
)

adminRouter.get(
  '/appointments',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'SUPPORT'),
  async (req, res) => {
    const appointments = await prisma.appointment.findMany({
      include: { user: true, professional: true },
      orderBy: { scheduledFor: 'desc' },
      take: 100,
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.appointments.list',
      resourceType: 'appointment',
    })

    res.json(
      appointments.map((a) => ({
        id: a.id,
        scheduledFor: a.scheduledFor,
        type: a.type,
        status: a.status,
        feeKes: a.feeKes,
        userId: a.userId,
        userFullName: a.user.fullName,
        professionalId: a.professionalId,
        professionalFullName: a.professional.fullName,
      }))
    )
  }
)

// Admins see every professional field (email included, for KYC follow-up)
// except the password hash.
adminRouter.get(
  '/professionals',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'CLINICAL_SAFETY_REVIEWER'),
  async (req, res) => {
    const professionals = await prisma.professional.findMany({
      orderBy: { createdAt: 'desc' },
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.professionals.list',
      resourceType: 'professional',
    })

    res.json(professionals.map(stripSecrets))
  }
)

const verifySchema = z.object({ verified: z.boolean() })

adminRouter.patch(
  '/professionals/:id/verify',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN'),
  async (req, res) => {
    const parsed = verifySchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    const professional = await prisma.professional.findUnique({ where: { id: req.params.id } })
    if (!professional) return res.status(404).json({ error: 'Professional not found.' })

    const updated = await prisma.professional.update({
      where: { id: req.params.id },
      data: { verified: parsed.data.verified },
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: parsed.data.verified ? 'professional.verify' : 'professional.unverify',
      resourceType: 'professional',
      resourceId: professional.id,
    })

    res.json(stripSecrets(updated))
  }
)

adminRouter.get(
  '/referrals',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN', 'CLINICAL_SAFETY_REVIEWER'),
  async (req, res) => {
    const referrals = await prisma.referral.findMany({
      include: { checkIn: true, professional: true, flags: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.referrals.list',
      resourceType: 'referral',
    })

    res.json(
      referrals.map((r) => ({
        id: r.id,
        userId: r.userId,
        status: r.status,
        reason: r.reason,
        riskLevel: r.checkIn.riskLevel,
        professionalFullName: r.professional?.fullName ?? 'Unassigned',
        flags: r.flags.map((f) => f.label),
        createdAt: r.createdAt,
      }))
    )
  }
)

adminRouter.get(
  '/analytics',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN'),
  async (req, res) => {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

    const [
      recentCheckIns,
      riskCounts,
      referralStatusCounts,
      appointmentStatusCounts,
      totalProfessionals,
      verifiedProfessionals,
      allAppointments,
    ] = await Promise.all([
      prisma.checkIn.findMany({
        where: { completedAt: { gte: fourteenDaysAgo } },
        select: { completedAt: true },
      }),
      prisma.checkIn.groupBy({ by: ['riskLevel'], _count: { riskLevel: true } }),
      prisma.referral.groupBy({ by: ['status'], _count: { status: true } }),
      prisma.appointment.groupBy({ by: ['status'], _count: { status: true } }),
      prisma.professional.count(),
      prisma.professional.count({ where: { verified: true } }),
      // Pulled once, broken down in JS below — a booking's "tier" isn't a
      // stored column, it's derived from whether an institution sponsored
      // it and how much: 100% covered reads as the corporate/EAP tier,
      // partially covered reads as the student/discount tier, and anything
      // with no institution at all is the standard self-pay tier.
      prisma.appointment.findMany({
        select: { feeKes: true, institutionCoveredKes: true, sponsoringInstitutionId: true },
      }),
    ])

    const dayBuckets = {}
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().slice(0, 10)
      dayBuckets[key] = 0
    }
    recentCheckIns.forEach((c) => {
      const key = c.completedAt.toISOString().slice(0, 10)
      if (key in dayBuckets) dayBuckets[key] += 1
    })

    const tierBreakdown = { standard: { count: 0, revenueKes: 0 }, student: { count: 0, revenueKes: 0 }, corporate: { count: 0, revenueKes: 0 } }
    for (const a of allAppointments) {
      const patientPaysKes = a.feeKes - a.institutionCoveredKes
      if (!a.sponsoringInstitutionId) {
        tierBreakdown.standard.count += 1
        tierBreakdown.standard.revenueKes += patientPaysKes
      } else if (a.institutionCoveredKes >= a.feeKes && a.feeKes > 0) {
        tierBreakdown.corporate.count += 1
        tierBreakdown.corporate.revenueKes += patientPaysKes
      } else {
        tierBreakdown.student.count += 1
        tierBreakdown.student.revenueKes += patientPaysKes
      }
    }

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.analytics.view',
      resourceType: 'platform',
    })

    res.json({
      checkInsByDay: Object.entries(dayBuckets).map(([date, count]) => ({ date, count })),
      riskLevelBreakdown: riskCounts.map((r) => ({ level: r.riskLevel, count: r._count.riskLevel })),
      referralStatusBreakdown: referralStatusCounts.map((r) => ({ status: r.status, count: r._count.status })),
      appointmentStatusBreakdown: appointmentStatusCounts.map((r) => ({ status: r.status, count: r._count.status })),
      professionals: { total: totalProfessionals, verified: verifiedProfessionals },
      tierBreakdown,
    })
  }
)

// --- Account deletion review queue ---
// The one place deletion requests actually get acted on. See the
// AccountDeletionRequest and ClinicalNote comments in schema.prisma for
// the reasoning behind review-then-delete rather than instant self-serve.
adminRouter.get(
  '/deletion-requests',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN'),
  async (req, res) => {
    const requests = await prisma.accountDeletionRequest.findMany({
      orderBy: { requestedAt: 'desc' },
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'admin.deletion_requests.list',
      resourceType: 'account_deletion_request',
    })

    res.json(requests)
  }
)

const processDeletionSchema = z.object({ action: z.enum(['DELETE', 'REJECT']) })

adminRouter.patch(
  '/deletion-requests/:id/process',
  requireAuth,
  requireAdminRole('PLATFORM_ADMIN'),
  async (req, res) => {
    const parsed = processDeletionSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    const request = await prisma.accountDeletionRequest.findUnique({ where: { id: req.params.id } })
    if (!request) return res.status(404).json({ error: 'Request not found.' })
    if (request.status !== 'PENDING') return res.status(409).json({ error: 'Request already processed.' })

    // Fetch the requesting admin's email for the audit trail.
    const admin = await prisma.admin.findUnique({ where: { id: req.auth.id } })

    if (parsed.data.action === 'REJECT') {
      const updated = await prisma.accountDeletionRequest.update({
        where: { id: request.id },
        data: { status: 'REJECTED', processedAt: new Date(), processedByEmail: admin?.email },
      })

      await audit({
        actorType: 'admin',
        actorId: req.auth.id,
        action: 'deletion_request.reject',
        resourceType: 'account_deletion_request',
        resourceId: request.id,
      })

      return res.json(updated)
    }

    // DELETE: actually remove the account. Cascades (see schema.prisma)
    // handle check-ins, referrals, appointments, and — for professionals —
    // documents. Clinical notes referencing this userId are deliberately
    // left in place; see the ClinicalNote comment in schema.prisma.
    // (Switching this to soft delete is a separate, planned step.)
    if (request.role === 'user') {
      await prisma.user.delete({ where: { id: request.accountId } }).catch(() => null)
    } else {
      await prisma.professional.delete({ where: { id: request.accountId } }).catch(() => null)
    }

    const updated = await prisma.accountDeletionRequest.update({
      where: { id: request.id },
      data: { status: 'COMPLETED', processedAt: new Date(), processedByEmail: admin?.email },
    })

    await audit({
      actorType: 'admin',
      actorId: req.auth.id,
      action: 'deletion_request.complete',
      resourceType: 'account_deletion_request',
      resourceId: request.id,
      metadata: { deletedRole: request.role, deletedAccountId: request.accountId },
    })

    res.json(updated)
  }
)
