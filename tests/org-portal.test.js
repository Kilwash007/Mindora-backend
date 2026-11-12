import './setup.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { app } from '../src/app.js'
import { prisma } from '../src/lib/prisma.js'
import { signAccessToken, verifyAccessToken } from '../src/lib/auth.js'
import { hashOtpCode, otpExpiryDate } from '../src/lib/otp.js'
import { buildWorld } from './fixtures.js'

// Step 7: what the institution portal's owners and admins can see.
//   - They sign in with password, then an emailed code (role "org").
//   - A healthcare provider sees its own patients' names and which of its
//     clinicians each one sees, never anything clinical.
//   - Everyone else (here an employer) sees totals only: no patient list, no
//     patient invitations listed back, no way to change a patient's access,
//     and any count from 1 to 4 comes back as null ("fewer than 5").

let server
let base
let world
let ipCounter = 0
const stamp = `org${Date.now()}`
const SECRET = `SECRET${stamp}`

function nextIp() {
  ipCounter += 1
  return `198.21.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`
}

async function call(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json, text }
}

const s = {}

async function makeWorkspace(key, type) {
  const org = await prisma.organization.create({
    data: { name: `${key} ${stamp}`, type, status: 'ACTIVE', escalationEmails: [] },
  })
  const owner = await prisma.orgAdmin.create({
    data: { fullName: `${key} Owner`, email: `${key}-owner-${stamp}@test.local`, passwordHash: 'not-a-real-hash' },
  })
  await prisma.organizationMembership.create({ data: { organizationId: org.id, role: 'ORG_OWNER', orgAdminId: owner.id } })
  const clinician = await prisma.professional.create({
    data: {
      fullName: `${key} Clinician ${stamp}`,
      email: `${key}-doc-${stamp}@test.local`,
      passwordHash: 'not-a-real-hash',
      type: 'PSYCHOLOGIST',
      verified: true,
    },
  })
  await prisma.organizationMembership.create({
    data: { organizationId: org.id, role: 'ORG_CLINICIAN', professionalId: clinician.id, licenceNumber: `LIC-${key}`, licenceExpiry: new Date('2030-12-31T00:00:00Z') },
  })
  return {
    org,
    owner,
    clinician,
    token: signAccessToken({ id: owner.id, role: 'org', orgId: org.id, orgRole: 'ORG_OWNER' }),
  }
}

async function addPatient(ws, n) {
  const user = await prisma.user.create({
    data: {
      fullName: `Patient ${n} of ${ws.org.name}`,
      email: `p${n}-${ws.org.id.slice(0, 8)}-${stamp}@test.local`,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: new Date('1990-01-01T00:00:00Z'),
      consentAcceptedAt: new Date(),
    },
  })
  const membership = await prisma.organizationMembership.create({
    data: { organizationId: ws.org.id, role: 'ORG_PATIENT', userId: user.id },
  })
  return { user, membership }
}

async function completedSession(ws, userId) {
  return prisma.appointment.create({
    data: {
      userId,
      professionalId: ws.clinician.id,
      scheduledFor: new Date(),
      type: 'ONLINE',
      status: 'COMPLETED',
      feeKes: 0,
      organizationId: ws.org.id,
    },
  })
}

test.before(async () => {
  world = await buildWorld()
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`

  s.provider = await makeWorkspace('Provider', 'PROVIDER')
  s.employer = await makeWorkspace('Employer', 'EMPLOYER')

  // Provider: two patients. The first had a session with the provider's
  // clinician and has sensitive records; the second was triaged by them.
  s.p1 = await addPatient(s.provider, 1)
  s.p2 = await addPatient(s.provider, 2)
  await completedSession(s.provider, s.p1.user.id)
  await prisma.checkIn.create({
    data: { userId: s.p1.user.id, riskLevel: 'ACUTE', totalScore: 27, maxScore: 30, organizationId: s.provider.org.id },
  })
  await prisma.clinicalNote.create({
    data: { professionalId: s.provider.clinician.id, userId: s.p1.user.id, content: `${SECRET} note`, organizationId: s.provider.org.id },
  })
  await prisma.message.create({
    data: { userId: s.p1.user.id, professionalId: s.provider.clinician.id, senderRole: 'user', content: `${SECRET} message`, organizationId: s.provider.org.id },
  })
  const triageCheckIn = await prisma.checkIn.create({
    data: { userId: s.p2.user.id, riskLevel: 'ELEVATED', totalScore: 12, maxScore: 30, organizationId: s.provider.org.id },
  })
  await prisma.triage.create({
    data: {
      userId: s.p2.user.id,
      checkInId: triageCheckIn.id,
      clinicianId: s.provider.clinician.id,
      status: 'COMPLETED',
      completedAt: new Date(),
      summary: `${SECRET} triage`,
      organizationId: s.provider.org.id,
    },
  })

  // Employer: three patients, each with one completed session this month.
  s.staff = []
  for (let n = 1; n <= 3; n += 1) {
    const p = await addPatient(s.employer, n)
    await completedSession(s.employer, p.user.id)
    s.staff.push(p)
  }
})

test.after(async () => {
  server?.close()
  await prisma.$disconnect()
})

test('an institution owner signs in with the emailed code and lands in their workspace', async () => {
  const email = s.provider.owner.email
  await prisma.loginOtp.create({
    data: { email, role: 'org', codeHash: hashOtpCode('246810'), expiresAt: otpExpiryDate() },
  })
  const wrong = await call('POST', '/api/auth/verify-otp', null, { role: 'org', email, code: '111111' })
  assert.equal(wrong.status, 401)

  const r = await call('POST', '/api/auth/verify-otp', null, { role: 'org', email, code: '246810' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.orgAdmin.email, email)
  assert.equal(r.body.workspace.id, s.provider.org.id)
  const claims = verifyAccessToken(r.body.accessToken)
  assert.equal(claims.role, 'org')
  assert.equal(claims.orgRole, 'ORG_OWNER')

  const me = await call('GET', '/api/org/me', r.body.accessToken)
  assert.equal(me.status, 200, me.text)
  assert.equal(me.body.workspace.type, 'PROVIDER')
  assert.equal(me.body.privacy.seesPatients, true)
})

test('an employer cannot list patients', async () => {
  const r = await call('GET', '/api/org/patients', s.employer.token)
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'PATIENTS_NOT_SHOWN')
  for (const p of s.staff) assert.ok(!r.text.includes(p.user.email))
})

test('an employer sees "fewer than 5" instead of a small patient count', async () => {
  const me = await call('GET', '/api/org/me', s.employer.token)
  assert.equal(me.status, 200, me.text)
  assert.equal(me.body.members.ORG_PATIENT, null)
  assert.equal(me.body.members.ORG_CLINICIAN, 1)
  assert.equal(me.body.privacy.seesPatients, false)
})

test('employer reports hide counts from 1 to 4 and show 5 or more', async () => {
  const before = await call('GET', '/api/org/reports', s.employer.token)
  assert.equal(before.status, 200, before.text)
  assert.equal(before.body.suppressed, true)
  assert.equal(before.body.months.length, 6)
  const thisMonth = before.body.months[before.body.months.length - 1]
  assert.equal(thisMonth.sessionsCompleted, null)
  assert.equal(thisMonth.patientsJoined, null)
  assert.equal(before.body.totals.sessionsCompleted, null)
  assert.equal(before.body.months[0].sessionsCompleted, 0, 'zero is shown')

  await completedSession(s.employer, s.staff[0].user.id)
  await completedSession(s.employer, s.staff[1].user.id)
  const after = await call('GET', '/api/org/reports', s.employer.token)
  assert.equal(after.body.months[after.body.months.length - 1].sessionsCompleted, 5)
  assert.equal(after.body.totals.sessionsCompleted, 5)
})

test('an employer never gets patient invitations listed back', async () => {
  const patientInvite = await call('POST', '/api/org/invites', s.employer.token, { email: `newstaff-${stamp}@test.local`, role: 'ORG_PATIENT' })
  assert.equal(patientInvite.status, 201, patientInvite.text)
  assert.ok(patientInvite.body.url.includes('/invite/'), 'the link is still returned once, to send it')
  const clinicianInvite = await call('POST', '/api/org/invites', s.employer.token, {
    email: `newdoc-${stamp}@test.local`,
    role: 'ORG_CLINICIAN',
    licenceNumber: 'PSY-12345',
    licenceExpiry: '2030-01-31',
  })
  assert.equal(clinicianInvite.status, 201, clinicianInvite.text)

  const list = await call('GET', '/api/org/invites', s.employer.token)
  assert.equal(list.status, 200)
  assert.ok(list.body.every((i) => i.role !== 'ORG_PATIENT'))
  assert.ok(list.body.some((i) => i.email === `newdoc-${stamp}@test.local`))
})

test("an employer cannot end or restore a patient's access", async () => {
  const r = await call('PATCH', `/api/org/members/${s.staff[0].membership.id}`, s.employer.token, { active: false })
  assert.equal(r.status, 404)
  const still = await prisma.organizationMembership.findUnique({ where: { id: s.staff[0].membership.id } })
  assert.equal(still.active, true)
})

test('a provider sees its patients and their clinicians, and nothing clinical', async () => {
  const r = await call('GET', '/api/org/patients', s.provider.token)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.length, 2)
  const byEmail = Object.fromEntries(r.body.map((p) => [p.email, p]))
  assert.deepEqual(byEmail[s.p1.user.email].clinicians.map((c) => c.id), [s.provider.clinician.id])
  assert.deepEqual(byEmail[s.p2.user.email].clinicians.map((c) => c.id), [s.provider.clinician.id])
  for (const forbidden of [SECRET, 'ACUTE', 'ELEVATED', 'riskLevel', 'totalScore', 'scheduledFor']) {
    assert.ok(!r.text.includes(forbidden), `must not include ${forbidden}`)
  }
  for (const p of s.staff) assert.ok(!r.text.includes(p.user.email), 'no other workspace patients')
  assert.ok(!r.text.includes(world.scopes.A.tag), 'nothing from the shared test workspaces')
})

test('provider reports show small numbers as they are', async () => {
  const r = await call('GET', '/api/org/reports', s.provider.token)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.suppressed, false)
  const thisMonth = r.body.months[r.body.months.length - 1]
  assert.equal(thisMonth.sessionsCompleted, 1)
  assert.equal(thisMonth.triagesCompleted, 1)
  assert.equal(r.body.totals.patientsJoined, 2)
})

test("a provider can end a patient's access", async () => {
  const r = await call('PATCH', `/api/org/members/${s.p2.membership.id}`, s.provider.token, { active: false })
  assert.equal(r.status, 200, r.text)
  const list = await call('GET', '/api/org/patients', s.provider.token)
  assert.equal(list.body.find((p) => p.email === s.p2.user.email).active, false)
})

test('patients and clinicians still cannot use the institution routes', async () => {
  const patient = signAccessToken({ id: s.p1.user.id, role: 'user', orgId: s.provider.org.id, orgRole: 'ORG_PATIENT' })
  const clinician = signAccessToken({ id: s.provider.clinician.id, role: 'professional', orgId: s.provider.org.id, orgRole: 'ORG_CLINICIAN' })
  for (const token of [patient, clinician]) {
    assert.equal((await call('GET', '/api/org/patients', token)).status, 403)
    assert.equal((await call('GET', '/api/org/reports', token)).status, 403)
  }
})
