import './setup.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../src/lib/prisma.js'
import { db, WorkspaceScopeError } from '../src/lib/db.js'

// The scoped client (src/lib/db.js) on its own: reads, writes and refusals.

const stamp = `dbscope-${Date.now()}`
const mine = { note: { startsWith: stamp } }
let orgA
let orgB
let rows

test.before(async () => {
  orgA = await prisma.organization.create({ data: { name: `${stamp} A`, type: 'NGO' } })
  orgB = await prisma.organization.create({ data: { name: `${stamp} B`, type: 'NGO' } })
  rows = {
    care: await prisma.safetyAlert.create({ data: { riskLevel: 'LOW', note: `${stamp} care` } }),
    a: await prisma.safetyAlert.create({ data: { riskLevel: 'LOW', note: `${stamp} A`, organizationId: orgA.id } }),
    b: await prisma.safetyAlert.create({ data: { riskLevel: 'LOW', note: `${stamp} B`, organizationId: orgB.id } }),
  }
})

test.after(async () => {
  await prisma.safetyAlert.deleteMany({ where: mine })
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } })
  await prisma.$disconnect()
})

const care = () => ({ orgId: null })
const inA = () => ({ orgId: orgA.id })

test('each scope reads only its own rows', async () => {
  assert.deepEqual((await db(care()).safetyAlert.findMany({ where: mine })).map((r) => r.id), [rows.care.id])
  assert.deepEqual((await db(inA()).safetyAlert.findMany({ where: mine })).map((r) => r.id), [rows.a.id])
  assert.deepEqual((await db({ orgId: orgB.id }).safetyAlert.findMany({ where: mine })).map((r) => r.id), [rows.b.id])
})

test('a scope cannot widen its filter or read by id across workspaces', async () => {
  const widened = await db(inA()).safetyAlert.findMany({ where: { ...mine, organizationId: orgB.id } })
  assert.ok(widened.every((r) => r.organizationId === orgA.id))
  assert.equal(await db(inA()).safetyAlert.findUnique({ where: { id: rows.b.id } }), null)
  assert.equal(await db(care()).safetyAlert.findFirst({ where: { id: rows.a.id } }), null)
})

test('a scope cannot change or delete another workspace\'s rows', async () => {
  const many = await db(inA()).safetyAlert.updateMany({ where: { id: rows.b.id }, data: { resolvedAt: new Date() } })
  assert.equal(many.count, 0)
  await assert.rejects(() => db(inA()).safetyAlert.update({ where: { id: rows.b.id }, data: { resolvedAt: new Date() } }))
  await assert.rejects(() => db(inA()).safetyAlert.delete({ where: { id: rows.b.id } }))
  assert.ok(await prisma.safetyAlert.findUnique({ where: { id: rows.b.id } }))
})

test('new rows are stamped with the scope', async () => {
  const a = await db(inA()).safetyAlert.create({ data: { riskLevel: 'LOW', note: `${stamp} A new` } })
  assert.equal(a.organizationId, orgA.id)
  const c = await db(care()).safetyAlert.create({ data: { riskLevel: 'LOW', note: `${stamp} care new` } })
  assert.equal(c.organizationId, null)
})

test('writes that set or change the workspace are refused', async () => {
  await assert.rejects(
    () => db(inA()).safetyAlert.create({ data: { riskLevel: 'LOW', note: `${stamp} x`, organizationId: orgB.id } }),
    WorkspaceScopeError
  )
  await assert.rejects(
    () => db(inA()).safetyAlert.updateMany({ where: mine, data: { organizationId: orgB.id } }),
    WorkspaceScopeError
  )
})

test('db() refuses to run without a request context', () => {
  assert.throws(() => db(undefined), WorkspaceScopeError)
})
