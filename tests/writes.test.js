import './setup.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { app } from '../src/app.js'
import { prisma } from '../src/lib/prisma.js'
import { SCREENING_QUESTIONS } from '../src/lib/screening.js'
import { buildWorld } from './fixtures.js'

// Workspace isolation for WRITES, through the real HTTP routes: what a
// workspace member creates belongs to their workspace, nothing can be
// booked, claimed, messaged or noted across workspaces, workspace care is
// covered (no M-Pesa), and Mindora Care-only features are closed to
// workspace members. The GET sweep (isolation.test.js) covers reads.

let server
let base
let world
let A
let care
let ipCounter = 0

function nextIp() {
  ipCounter += 1
  return `198.19.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`
}

async function call(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': nextIp(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, body: json }
}

function answers(selfHarm) {
  return SCREENING_QUESTIONS.map((q) => ({
    domain: q.domain,
    questionId: q.id,
    value: q.id === 'phq9_9' ? selfHarm : 0,
  }))
}

// A completed triage recommending psychology, so the patient may book.
async function completedTriageFor(scope) {
  const checkIn = await prisma.checkIn.create({
    data: { userId: scope.patientId, riskLevel: 'ELEVATED', totalScore: 12, maxScore: 52, organizationId: scope.organizationId },
  })
  await prisma.triage.create({
    data: {
      userId: scope.patientId,
      checkInId: checkIn.id,
      clinicianId: scope.clinicianId,
      status: 'COMPLETED',
      careLevel: 'PSYCHOLOGY',
      urgency: 'ROUTINE',
      completedAt: new Date(),
      organizationId: scope.organizationId,
    },
  })
}

function daysFromNow(days, hourUtc) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  d.setUTCHours(hourUtc, 0, 0, 0)
  return d.toISOString()
}

test.before(async () => {
  world = await buildWorld()
  A = world.scopes.A
  care = world.scopes.care
  for (const [service, priceKes] of [['TRIAGE', 500], ['PSYCHOLOGY', 4000]]) {
    await prisma.servicePrice.upsert({
      where: { service },
      create: { service, priceKes, payoutPercent: 65, active: true },
      update: { priceKes, active: true },
    })
  }
  await completedTriageFor(A)
  await completedTriageFor(care)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  server?.close()
  await prisma.$disconnect()
})

test("a workspace patient's screening, safety alert and urgent triage stay in their workspace", async () => {
  const r = await call('POST', '/api/v1/screenings', A.actors.patient, { answers: answers(1) })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.ok(r.body.triageId, 'an urgent triage should open')
  const checkIn = await prisma.checkIn.findUnique({ where: { id: r.body.id } })
  assert.equal(checkIn.organizationId, A.organizationId)
  const triage = await prisma.triage.findUnique({ where: { id: r.body.triageId } })
  assert.equal(triage.organizationId, A.organizationId)
  const alert = await prisma.safetyAlert.findFirst({ where: { userId: A.patientId }, orderBy: { createdAt: 'desc' } })
  assert.equal(alert.organizationId, A.organizationId)
})

test("a Mindora Care patient's screening stays in Mindora Care", async () => {
  const r = await call('POST', '/api/v1/screenings', care.actors.patient, { answers: answers(0) })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.covered, false)
  const checkIn = await prisma.checkIn.findUnique({ where: { id: r.body.id } })
  assert.equal(checkIn.organizationId, null)
})

test('a workspace triage is covered: it joins the queue with no payment', async () => {
  const s = await call('POST', '/api/v1/screenings', A.actors.patient, { answers: answers(0) })
  assert.equal(s.status, 201, JSON.stringify(s.body))
  assert.equal(s.body.covered, true)
  const t = await call('POST', '/api/v1/triage', A.actors.patient, { checkInId: s.body.id })
  assert.equal(t.status, 201, JSON.stringify(t.body))
  assert.equal(t.body.status, 'QUEUED')
  const stored = await prisma.triage.findUnique({ where: { id: t.body.id } })
  assert.equal(stored.organizationId, A.organizationId)
  const pay = await call('POST', `/api/v1/triage/${t.body.id}/pay`, A.actors.patient, {})
  assert.equal(pay.status, 400)
})

test("a clinician cannot claim another workspace's triage", async () => {
  const cross = await call('POST', `/api/v1/triage/${A.triageId}/claim`, care.actors.clinician)
  assert.equal(cross.status, 409)
  assert.equal((await prisma.triage.findUnique({ where: { id: A.triageId } })).clinicianId, null)
  const own = await call('POST', `/api/v1/triage/${A.triageId}/claim`, A.actors.clinician)
  assert.equal(own.status, 200, JSON.stringify(own.body))
})

test('patients can only book clinicians in their own scope', async () => {
  const intoCare = await call('POST', '/api/v1/appointments', A.actors.patient, {
    professionalId: care.clinicianId,
    scheduledFor: daysFromNow(5, 7),
    type: 'ONLINE',
  })
  assert.equal(intoCare.status, 404, JSON.stringify(intoCare.body))
  const intoA = await call('POST', '/api/v1/appointments', care.actors.patient, {
    professionalId: A.clinicianId,
    scheduledFor: daysFromNow(5, 9),
    type: 'ONLINE',
  })
  assert.equal(intoA.status, 404, JSON.stringify(intoA.body))
})

test('a workspace session is covered: booked with nothing to pay and no M-Pesa prompt', async () => {
  const r = await call('POST', '/api/v1/appointments', A.actors.patient, {
    professionalId: A.clinicianId,
    scheduledFor: daysFromNow(6, 7),
    type: 'ONLINE',
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.amountDueKes, 0)
  assert.equal(r.body.paymentRequired, false)
  assert.ok(r.body.meetingUrl, 'the video link is ready straight away')
  const stored = await prisma.appointment.findUnique({ where: { id: r.body.id } })
  assert.equal(stored.organizationId, A.organizationId)
  const pay = await call('POST', '/api/payments/initiate', A.actors.patient, { appointmentId: r.body.id })
  assert.equal(pay.status, 400)
})

test('messages cannot cross workspaces', async () => {
  const cross = await call('POST', '/api/messages', A.actors.patient, { otherPartyId: care.clinicianId, content: 'hello' })
  assert.equal(cross.status, 403)
  const own = await call('POST', '/api/messages', A.actors.patient, { otherPartyId: A.clinicianId, content: 'hello' })
  assert.equal(own.status, 201, JSON.stringify(own.body))
  assert.equal(own.body.organizationId, A.organizationId)
})

test('clinical notes cannot be written about patients in another scope', async () => {
  const r = await call('POST', `/api/clients/${care.patientId}/notes`, A.actors.clinician, { content: 'note' })
  assert.equal(r.status, 404)
})

test('Mindora Care-only features are closed to workspace members', async () => {
  for (const [method, path] of [
    ['GET', '/api/groups'],
    ['GET', '/api/student-rate/status'],
    ['POST', '/api/ai/chat'],
    ['GET', '/api/account/institution'],
  ]) {
    const r = await call(method, path, A.actors.patient, method === 'POST' ? {} : undefined)
    assert.equal(r.status, 403, `${method} ${path}`)
    assert.equal(r.body?.code, 'NOT_IN_WORKSPACE', `${method} ${path}`)
  }
  const careGroups = await call('GET', '/api/groups', care.actors.patient)
  assert.notEqual(careGroups.body?.code, 'NOT_IN_WORKSPACE')
})

test("Mindora's admin totals leave workspaces out", async () => {
  const r = await call('GET', '/api/admin/overview', world.mindoraAdmin)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const careUsers = await prisma.user.count({ where: { orgMembership: { is: null } } })
  assert.equal(r.body.totalUsers, careUsers)
})
