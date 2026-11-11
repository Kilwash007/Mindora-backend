import crypto from 'crypto'
import { prisma } from '../src/lib/prisma.js'
import { signAccessToken } from '../src/lib/auth.js'
import { CURRENT_AGREEMENT_VERSION } from '../src/lib/agreement.js'

// Builds three separate worlds in the test database:
//   care : Mindora Care (no workspace)
//   A, B : two institution workspaces
// Each has a patient, a clinician, a full trail of clinical records between
// them, and (for A and B) an institution owner. Every name and text field
// carries the scope's tag (e.g. LEAKA3f9c1), so if any of it shows up in a
// response for another scope, the leak is found by a plain text search.

function tagFor(key) {
  return `LEAK${key.toUpperCase()}${crypto.randomBytes(3).toString('hex')}`
}

async function buildScope(key) {
  const tag = tagFor(key)
  const lower = tag.toLowerCase()

  const org =
    key === 'care'
      ? null
      : await prisma.organization.create({
          data: { name: `Workspace ${tag}`, type: 'NGO', status: 'ACTIVE', escalationEmails: [] },
        })
  const organizationId = org?.id ?? null

  const patient = await prisma.user.create({
    data: {
      fullName: `Patient ${tag}`,
      email: `patient-${lower}@test.local`,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: new Date('1995-01-01T00:00:00Z'),
      consentAcceptedAt: new Date(),
    },
  })

  const clinician = await prisma.professional.create({
    data: {
      fullName: `Clinician ${tag}`,
      email: `clinician-${lower}@test.local`,
      passwordHash: 'not-a-real-hash',
      type: 'PSYCHOLOGIST',
      bio: `Bio ${tag}`,
      verified: true,
      feeKes: 3000,
      onlineAvailable: true,
      onCallForTriage: true,
      agreementAcceptedAt: new Date(),
      agreementVersion: CURRENT_AGREEMENT_VERSION,
    },
  })

  let orgAdmin = null
  if (org) {
    await prisma.organizationMembership.create({
      data: { organizationId, role: 'ORG_PATIENT', userId: patient.id },
    })
    await prisma.organizationMembership.create({
      data: {
        organizationId,
        role: 'ORG_CLINICIAN',
        professionalId: clinician.id,
        licenceNumber: `LIC-${tag}`,
        licenceExpiry: new Date('2030-12-31T00:00:00Z'),
      },
    })
    orgAdmin = await prisma.orgAdmin.create({
      data: { fullName: `Owner ${tag}`, email: `owner-${lower}@test.local`, passwordHash: 'not-a-real-hash' },
    })
    await prisma.organizationMembership.create({
      data: { organizationId, role: 'ORG_OWNER', orgAdminId: orgAdmin.id },
    })
  }

  const checkIn = await prisma.checkIn.create({
    data: { userId: patient.id, riskLevel: 'HIGH', totalScore: 20, maxScore: 30, organizationId },
  })
  const triageCheckIn = await prisma.checkIn.create({
    data: { userId: patient.id, riskLevel: 'ELEVATED', totalScore: 14, maxScore: 30, organizationId },
  })
  const referral = await prisma.referral.create({
    data: {
      userId: patient.id,
      checkInId: checkIn.id,
      professionalId: clinician.id,
      status: 'ACCEPTED',
      reason: `Reason ${tag}`,
      organizationId,
    },
  })
  const appointment = await prisma.appointment.create({
    data: {
      userId: patient.id,
      professionalId: clinician.id,
      scheduledFor: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      type: 'ONLINE',
      status: 'SCHEDULED',
      feeKes: 3000,
      organizationId,
    },
  })
  const note = await prisma.clinicalNote.create({
    data: { professionalId: clinician.id, userId: patient.id, content: `Note ${tag}`, organizationId },
  })
  const message = await prisma.message.create({
    data: {
      userId: patient.id,
      professionalId: clinician.id,
      senderRole: 'user',
      content: `Message ${tag}`,
      organizationId,
    },
  })
  const triage = await prisma.triage.create({
    data: {
      userId: patient.id,
      checkInId: triageCheckIn.id,
      status: 'QUEUED',
      summary: `Triage ${tag}`,
      organizationId,
    },
  })
  const alert = await prisma.safetyAlert.create({
    data: { userId: patient.id, referralId: referral.id, riskLevel: 'HIGH', note: `Alert ${tag}`, organizationId },
  })
  const payment = await prisma.payment.create({
    data: {
      appointmentId: appointment.id,
      phoneNumber: '254700000000',
      amountKes: 3000,
      status: 'PAID',
      resultDesc: `Payment ${tag}`,
      organizationId,
    },
  })

  const claims = (role) => (org ? { orgId: organizationId, orgRole: role } : {})
  const actors = {
    patient: signAccessToken({ id: patient.id, role: 'user', ...claims('ORG_PATIENT') }),
    clinician: signAccessToken({ id: clinician.id, role: 'professional', ...claims('ORG_CLINICIAN') }),
  }
  if (orgAdmin) actors.owner = signAccessToken({ id: orgAdmin.id, role: 'org', ...claims('ORG_OWNER') })

  // Ids worth trying in /:id style routes, and everything that must never
  // appear in another scope's responses.
  const ids = [
    patient.id,
    clinician.id,
    checkIn.id,
    referral.id,
    appointment.id,
    note.id,
    message.id,
    triage.id,
    alert.id,
    payment.id,
  ]
  const markers = [tag, ...ids, triageCheckIn.id, organizationId, orgAdmin?.id].filter(Boolean)

  return { key, tag, organizationId, actors, ids, markers }
}

export async function buildWorld() {
  const scopes = {}
  for (const key of ['care', 'A', 'B']) scopes[key] = await buildScope(key)

  const admin = await prisma.admin.create({
    data: {
      fullName: 'Test Platform Admin',
      email: `platform-admin-${crypto.randomBytes(3).toString('hex')}@test.local`,
      passwordHash: 'not-a-real-hash',
      role: 'PLATFORM_ADMIN',
    },
  })
  const mindoraAdmin = signAccessToken({ id: admin.id, role: 'admin', adminRole: 'PLATFORM_ADMIN' })

  return { scopes, mindoraAdmin }
}
