import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireAdminRole } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { wrap, HttpError } from '../../lib/wrap.js'
import { SERVICE_LABELS } from '../../lib/priceList.js'

export const pricesRouter = Router()

// Public: the price list shown on the website and in the apps.
pricesRouter.get('/', wrap(async (_req, res) => {
  const rows = await prisma.servicePrice.findMany({ where: { active: true }, orderBy: { priceKes: 'asc' } })
  res.json(
    rows.map((r) => ({
      service: r.service,
      label: SERVICE_LABELS[r.service] ?? r.service,
      priceKes: r.priceKes,
      studentPriceKes: r.studentPriceKes,
    }))
  )
}))

// Admin: the full rows, including payout percentages and inactive services.
pricesRouter.get('/admin', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (_req, res) => {
  const rows = await prisma.servicePrice.findMany({ orderBy: { priceKes: 'asc' } })
  res.json(rows.map((r) => ({ ...r, label: SERVICE_LABELS[r.service] ?? r.service })))
}))

const serviceSchema = z.enum(['TRIAGE', 'COUNSELLING', 'PSYCHOLOGY', 'PSYCHIATRY_INITIAL', 'PSYCHIATRY_FOLLOWUP'])

const updateSchema = z.object({
  priceKes: z.number().int().min(0).max(200000).optional(),
  studentPriceKes: z.number().int().min(0).max(200000).nullable().optional(),
  payoutPercent: z.number().int().min(0).max(100).optional(),
  active: z.boolean().optional(),
})

// Changes apply to new bookings and new payments only. Appointments and
// triages that already exist keep the amounts they were created with.
pricesRouter.patch('/:service', requireAuth, requireAdminRole('PLATFORM_ADMIN'), wrap(async (req, res) => {
  const service = serviceSchema.safeParse(req.params.service)
  if (!service.success) throw new HttpError(404, 'Unknown service.')

  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  if (Object.keys(parsed.data).length === 0) throw new HttpError(400, 'Nothing to update.')

  const existing = await prisma.servicePrice.findUnique({ where: { service: service.data } })
  if (!existing) throw new HttpError(404, 'Service not found.')

  const updated = await prisma.servicePrice.update({ where: { service: service.data }, data: parsed.data })

  await audit({
    actorType: 'admin',
    actorId: req.auth.id,
    action: 'price.update',
    resourceType: 'service_price',
    resourceId: service.data,
    metadata: { before: existing, changes: parsed.data },
  })

  res.json(updated)
}))
