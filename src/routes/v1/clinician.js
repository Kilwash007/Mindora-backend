import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireRole, requireAgreement } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { wrap, HttpError } from '../../lib/wrap.js'
import { TRIAGE_CLINICIAN_TYPES } from '../../lib/triage.js'

export const clinicianRouter = Router()

// Whether this professional can take triage at all: verified, not deleted,
// and one of the clinician types allowed to do triage.
async function loadClinician(id) {
  const me = await prisma.professional.findUnique({
    where: { id },
    select: { type: true, verified: true, deletedAt: true, onCallForTriage: true },
  })
  if (!me || me.deletedAt) throw new HttpError(404, 'Account not found.')
  const eligible = me.verified && TRIAGE_CLINICIAN_TYPES.includes(me.type)
  return { me, eligible }
}

// The clinician's own "on call for triage" switch. New triages are shared
// round-robin among clinicians who are on call.
clinicianRouter.get('/on-call', requireAuth, requireRole('professional'), requireAgreement, wrap(async (req, res) => {
  const { me, eligible } = await loadClinician(req.auth.id)
  res.json({ eligible, onCall: eligible && me.onCallForTriage })
}))

const onCallSchema = z.object({ onCall: z.boolean() })

clinicianRouter.put('/on-call', requireAuth, requireRole('professional'), requireAgreement, wrap(async (req, res) => {
  const parsed = onCallSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { eligible } = await loadClinician(req.auth.id)
  if (!eligible) {
    throw new HttpError(
      403,
      'Triage is available to verified psychiatric clinical officers, psychiatric nurses, psychologists and psychiatrists.'
    )
  }

  await prisma.professional.update({
    where: { id: req.auth.id },
    data: { onCallForTriage: parsed.data.onCall },
  })

  await audit({
    actorType: 'professional',
    actorId: req.auth.id,
    action: parsed.data.onCall ? 'triage.on_call.start' : 'triage.on_call.stop',
    resourceType: 'professional',
    resourceId: req.auth.id,
  })

  res.json({ eligible: true, onCall: parsed.data.onCall })
}))
