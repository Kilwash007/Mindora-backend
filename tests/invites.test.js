import './setup.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { app } from '../src/app.js'
import { prisma } from '../src/lib/prisma.js'
import { verifyAccessToken } from '../src/lib/auth.js'
import { workspaceClaims } from '../src/lib/workspace.js'
import { buildWorld } from './fixtures.js'

// Step 6: workspaces and invitations, through the real HTTP routes.
// Mindora creates a workspace and invites its owner; the owner invites a
// clinician and a patient; each accepts and is signed straight into that
// workspace. Invitations work once, only inside their own workspace, and
// never hand an existing account (or an under-18) a way in.

let server
let base
let world
let ipCounter = 0
const stamp = `inv${Date.now()}`

function nextIp() {
  ipCounter += 1
  return `198.20.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`
}

async function call(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, body: json }
}

const tokenFrom = (url) => url.split('/invite/')[1]

// Shared between tests, in order.
const state = {}

test.before(async () => {
  world = await buildWorld()
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  server?.close()
  await prisma.$disconnect()
})

test('only a Mindora platform admin can create a workspace', async () => {
  const body = { name: `Demo ${stamp}`, type: 'EMPLOYER', plan: 'demo', escalationEmails: [`alerts-${stamp}@test.local`] }
  const asPatient = await call('POST', '/api/admin/organizations', world.scopes.care.actors.patient, body)
  assert.equal(asPatient.status, 403)
  const asOwner = await call('POST', '/api/admin/organizations', world.scopes.A.actors.owner, body)
  assert.equal(asOwner.status, 403)

  const r = await call('POST', '/api/admin/organizations', world.mindoraAdmin, body)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.plan, 'demo')
  assert.equal(r.body.status, 'TRIAL')
  state.orgId = r.body.id
})

test('Mindora invites the owner, who accepts and is signed into the workspace', async () => {
  const email = `owner-${stamp}@test.local`
  const inv = await call('POST', `/api/admin/organizations/${state.orgId}/invites`, world.mindoraAdmin, { email, role: 'ORG_OWNER' })
  assert.equal(inv.status, 201, JSON.stringify(inv.body))
  assert.equal(inv.body.status, 'PENDING')
  assert.ok(inv.body.url.includes('/invite/'))
  const token = tokenFrom(inv.body.url)

  const preview = await call('GET', `/api/invites/${token}`)
  assert.equal(preview.status, 200)
  assert.equal(preview.body.role, 'ORG_OWNER')
  assert.equal(preview.body.organization.name, `Demo ${stamp}`)

  const accepted = await call('POST', `/api/invites/${token}/accept`, null, { fullName: 'Demo Owner', password: 'ownerpass123' })
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body))
  assert.equal(accepted.body.role, 'org')
  const claims = verifyAccessToken(accepted.body.accessToken)
  assert.equal(claims.orgId, state.orgId)
  assert.equal(claims.orgRole, 'ORG_OWNER')
  state.ownerToken = accepted.body.accessToken

  const again = await call('POST', `/api/invites/${token}/accept`, null, { fullName: 'Demo Owner', password: 'ownerpass123' })
  assert.equal(again.status, 410, 'a link works once')
})

test('the owner sees their own workspace and can update its contacts', async () => {
  const me = await call('GET', '/api/org/me', state.ownerToken)
  assert.equal(me.status, 200, JSON.stringify(me.body))
  assert.equal(me.body.workspace.id, state.orgId)
  assert.equal(me.body.members.ORG_OWNER, 1)

  const s = await call('PATCH', '/api/org/settings', state.ownerToken, { billingEmail: `billing-${stamp}@test.local` })
  assert.equal(s.status, 200)
})

test('a clinician invite carries the licence, and accepting it creates a verified workspace clinician', async () => {
  const noLicence = await call('POST', '/api/org/invites', state.ownerToken, { email: `doc-${stamp}@test.local`, role: 'ORG_CLINICIAN' })
  assert.equal(noLicence.status, 400)

  const inv = await call('POST', '/api/org/invites', state.ownerToken, {
    email: `doc-${stamp}@test.local`,
    role: 'ORG_CLINICIAN',
    licenceNumber: `PSY-${stamp}`,
    licenceExpiry: '2030-06-30',
  })
  assert.equal(inv.status, 201, JSON.stringify(inv.body))
  const accepted = await call('POST', `/api/invites/${tokenFrom(inv.body.url)}/accept`, null, {
    fullName: 'Demo Clinician',
    password: 'docpass1234',
    type: 'PSYCHOLOGIST',
  })
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body))
  const pro = await prisma.professional.findUnique({ where: { id: accepted.body.account.id }, include: { orgMembership: true } })
  assert.equal(pro.verified, true)
  assert.equal(pro.orgMembership.organizationId, state.orgId)
  assert.equal(pro.orgMembership.licenceNumber, `PSY-${stamp}`)
  state.clinicianId = pro.id
  state.clinicianMembershipId = pro.orgMembership.id

  const list = await call('GET', '/api/org/members?role=ORG_CLINICIAN', state.ownerToken)
  assert.equal(list.status, 200)
  assert.equal(list.body.length, 1)
  assert.equal(list.body[0].licenceNumber, `PSY-${stamp}`)
})

test('a patient invite: under 18 is refused and nothing is stored; an adult joins the workspace', async () => {
  const inv = await call('POST', '/api/org/invites', state.ownerToken, { email: `staff-${stamp}@test.local`, role: 'ORG_PATIENT' })
  assert.equal(inv.status, 201, JSON.stringify(inv.body))
  const token = tokenFrom(inv.body.url)

  const minor = await call('POST', `/api/invites/${token}/accept`, null, {
    fullName: 'Young Person',
    password: 'youngpass123',
    dateOfBirth: '2012-01-01',
    consent: true,
  })
  assert.equal(minor.status, 403)
  assert.equal(minor.body.code, 'UNDER_18')
  assert.equal(await prisma.user.count({ where: { email: `staff-${stamp}@test.local` } }), 0)

  const adult = await call('POST', `/api/invites/${token}/accept`, null, {
    fullName: 'Demo Staff',
    password: 'staffpass123',
    dateOfBirth: '1990-04-12',
    consent: true,
  })
  assert.equal(adult.status, 201, JSON.stringify(adult.body))
  const claims = verifyAccessToken(adult.body.accessToken)
  assert.equal(claims.role, 'user')
  assert.equal(claims.orgId, state.orgId)
  assert.equal(claims.orgRole, 'ORG_PATIENT')
})

test('an email that already has an account of that kind cannot be invited', async () => {
  const existing = await prisma.user.findUnique({ where: { id: world.scopes.care.patientId } })
  const r = await call('POST', '/api/org/invites', state.ownerToken, { email: existing.email.toUpperCase(), role: 'ORG_PATIENT' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'EMAIL_IN_USE')
})

test('withdrawn and expired invitations no longer work', async () => {
  const one = await call('POST', '/api/org/invites', state.ownerToken, { email: `gone-${stamp}@test.local`, role: 'ORG_PATIENT' })
  const revoke = await call('POST', `/api/org/invites/${one.body.id}/revoke`, state.ownerToken)
  assert.equal(revoke.status, 200)
  assert.equal((await call('GET', `/api/invites/${tokenFrom(one.body.url)}`)).status, 410)

  const two = await call('POST', '/api/org/invites', state.ownerToken, { email: `late-${stamp}@test.local`, role: 'ORG_PATIENT' })
  await prisma.organizationInvite.update({ where: { id: two.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
  const late = await call('POST', `/api/invites/${tokenFrom(two.body.url)}/accept`, null, {
    fullName: 'Too Late',
    password: 'latepass123',
    dateOfBirth: '1990-01-01',
    consent: true,
  })
  assert.equal(late.status, 410)
})

test("an owner cannot touch another workspace's invitations or people", async () => {
  const otherInvite = await call('POST', '/api/org/invites', world.scopes.A.actors.owner, { email: `a-${stamp}@test.local`, role: 'ORG_PATIENT' })
  assert.equal(otherInvite.status, 201, JSON.stringify(otherInvite.body))
  const cross = await call('POST', `/api/org/invites/${otherInvite.body.id}/revoke`, state.ownerToken)
  assert.equal(cross.status, 404)

  const aClinician = await prisma.organizationMembership.findFirst({
    where: { organizationId: world.scopes.A.organizationId, role: 'ORG_CLINICIAN' },
  })
  const endCross = await call('PATCH', `/api/org/members/${aClinician.id}`, state.ownerToken, { active: false })
  assert.equal(endCross.status, 404)

  const theirs = await call('GET', '/api/org/invites', state.ownerToken)
  assert.ok(theirs.body.every((i) => !i.email.startsWith('a-')))
})

test('patients and clinicians cannot use the institution admin routes', async () => {
  assert.equal((await call('GET', '/api/org/me', world.scopes.A.actors.patient)).status, 403)
  assert.equal((await call('GET', '/api/org/me', world.scopes.A.actors.clinician)).status, 403)
  assert.equal((await call('GET', '/api/org/me', world.scopes.care.actors.patient)).status, 403)
})

test('ending a clinician\'s access stops their sign-in straight away', async () => {
  const r = await call('PATCH', `/api/org/members/${state.clinicianMembershipId}`, state.ownerToken, { active: false })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const claims = await workspaceClaims('professional', state.clinicianId)
  assert.equal(claims.ok, false)
  assert.equal(claims.code, 'WORKSPACE_ACCESS_ENDED')
})

test("Mindora's workspace page shows totals and owner invitations, never patients' details", async () => {
  const r = await call('GET', `/api/admin/organizations/${state.orgId}`, world.mindoraAdmin)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.members.ORG_PATIENT, 1)
  assert.ok(r.body.invites.every((i) => i.role === 'ORG_OWNER' || i.role === 'ORG_ADMIN'))
  const text = JSON.stringify(r.body)
  assert.ok(!text.includes(`staff-${stamp}`), 'no patient emails')
  assert.ok(!text.includes(`doc-${stamp}`), 'no clinician emails')
})
