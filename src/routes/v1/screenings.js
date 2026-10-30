import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireRole } from '../../middleware/auth.js'
import { audit } from '../../lib/audit.js'
import { wrap, HttpError } from '../../lib/wrap.js'
import { scoreCheckIn } from '../../lib/screening.js'
import { answersSchema, validateAnswersShape } from '../../lib/screeningValidation.js'
import {
  CRISIS_RESOURCES,
  SUBSTANCE_RESOURCE,
  assignClinician,
  isScreeningValid,
  screeningValidUntil,
} from '../../lib/triage.js'

export const screeningsRouter = Router()

// Free, mandatory screening. Same instruments and scoring as before
// (PHQ-9, GAD-7, CAGE-AID, scored on the server). The difference is what
// happens next: an ACUTE result (which always means PHQ-9 item 9 was
// positive) creates a FREE urgent triage straight away, never behind a
// paywall. Every other result is told to pay for a triage.
screeningsRouter.post('/', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const parsed = answersSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { answers } = parsed.data
  const shapeError = validateAnswersShape(answers)
  if (shapeError) throw new HttpError(400, shapeError)

  const answersMap = Object.fromEntries(answers.map((a) => [a.questionId, a.value]))
  const { riskLevel, substanceFlag, totalScore, maxScore, phq9Score, gad7Score, cageScore } =
    scoreCheckIn(answersMap)
  const isCrisis = riskLevel === 'ACUTE'
  const userId = req.auth.id

  const { checkIn, triage } = await prisma.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.create({
      data: { userId, riskLevel, totalScore, maxScore, answers: { create: answers } },
    })

    if (riskLevel === 'HIGH' || riskLevel === 'ACUTE') {
      await tx.safetyAlert.create({
        data: {
          userId,
          riskLevel,
          note: isCrisis
            ? 'Screening responses indicate a possible acute risk (PHQ-9 self-harm item positive). A free urgent triage has been opened and requires urgent professional review.'
            : 'Screening responses indicate a high level of concern (PHQ-9 or GAD-7 severe range) and require prompt clinical assessment.',
        },
      })
    }

    let triage = null
    if (isCrisis) {
      const clinicianId = await assignClinician(tx)
      triage = await tx.triage.create({
        data: {
          userId,
          checkInId: checkIn.id,
          isFree: true,
          status: 'QUEUED',
          urgency: 'URGENT',
          clinicianId,
        },
      })
    }
    return { checkIn, triage }
  })

  await audit({
    actorType: 'user',
    actorId: userId,
    action: 'screening.submit',
    resourceType: 'check_in',
    resourceId: checkIn.id,
    metadata: { riskLevel, substanceFlag, phq9Score, gad7Score, cageScore, freeTriageId: triage?.id ?? null },
  })

  res.status(201).json({
    id: checkIn.id,
    riskLevel,
    totalScore,
    maxScore,
    phq9Score,
    gad7Score,
    cageScore,
    substanceFlag,
    completedAt: checkIn.completedAt,
    validUntil: screeningValidUntil(checkIn.completedAt),
    isCrisis,
    next: isCrisis ? 'FREE_TRIAGE' : 'PAY_TRIAGE',
    triageId: triage?.id ?? null,
    crisis: substanceFlag ? [...CRISIS_RESOURCES, SUBSTANCE_RESOURCE] : CRISIS_RESOURCES,
  })
}))

// The patient's most recent screening, whether it is still valid, and any
// triage already started from it.
screeningsRouter.get('/latest', requireAuth, requireRole('user'), wrap(async (req, res) => {
  const checkIn = await prisma.checkIn.findFirst({
    where: { userId: req.auth.id },
    orderBy: { completedAt: 'desc' },
    include: { triage: { select: { id: true, status: true, isFree: true, careLevel: true } } },
  })
  if (!checkIn) throw new HttpError(404, 'No screening yet.')

  res.json({
    id: checkIn.id,
    riskLevel: checkIn.riskLevel,
    totalScore: checkIn.totalScore,
    maxScore: checkIn.maxScore,
    completedAt: checkIn.completedAt,
    validUntil: screeningValidUntil(checkIn.completedAt),
    valid: isScreeningValid(checkIn.completedAt),
    triage: checkIn.triage,
  })
}))
