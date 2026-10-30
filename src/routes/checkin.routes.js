import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

export const checkInRouter = Router()

// Submitting a screening has moved to POST /api/v1/screenings. That route
// scores it on the server and, when the answers show risk of self-harm,
// opens a free urgent triage. This old route no longer records anything: it
// would skip that crisis path. It answers with a clear message so a page
// that has not been refreshed knows what to do.
checkInRouter.post('/', requireAuth, requireRole('user'), (_req, res) => {
  res.status(410).json({
    error: 'The screening has moved. Please refresh the page and take the free screening again.',
    code: 'SCREENING_MOVED',
  })
})

// Full check-in history for the logged-in user, oldest first — used by the
// dashboard's stats cards and the wellbeing journey chart. Includes raw
// per-domain answers so the client can compute domain-level trends
// without a second round trip.
checkInRouter.get('/', requireAuth, requireRole('user'), async (req, res) => {
  const checkIns = await prisma.checkIn.findMany({
    where: { userId: req.auth.id },
    orderBy: { completedAt: 'asc' },
    include: { answers: true },
  })
  res.json(checkIns)
})

// Most recent check-in for the logged-in user — used to render the
// dashboard's "current wellbeing" card and the result screen on refresh.
checkInRouter.get('/latest', requireAuth, requireRole('user'), async (req, res) => {
  const checkIn = await prisma.checkIn.findFirst({
    where: { userId: req.auth.id },
    orderBy: { completedAt: 'desc' },
  })

  if (!checkIn) return res.status(404).json({ error: 'No check-ins yet.' })
  res.json(checkIn)
})
