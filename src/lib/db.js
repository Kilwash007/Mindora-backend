import { prisma } from './prisma.js'

// The scoped database client for Mindora for Institutions.
//
//   import { db } from '../lib/db.js'
//   const notes = await db(req.ctx).clinicalNote.findMany({ where: { userId } })
//
// On the tenant models below, every query made through db(ctx) is limited to
// the caller's workspace, and every new row is stamped with it:
//   - Mindora Care (ctx.orgId empty): only rows whose organizationId is empty.
//   - A workspace: only that workspace's rows.
// A caller can't widen this: an organizationId in their own filter is
// overridden, and a write that tries to set or change organizationId is
// refused with an error.
//
// What it does NOT cover (so tenant routes must not use these):
//   - prisma.$queryRaw / $executeRaw
//   - nested writes started from another model, e.g.
//     user.update({ data: { checkIns: { create: ... } } })
//   - include/select of tenant rows through a non-tenant model, e.g.
//     user.findUnique({ include: { checkIns: true } })
// The isolation tests (Step 4) check the routes for exactly these.
//
// Platform-wide work that must see every workspace (Mindora's
// Organizations page, usage totals, invoices) uses the plain `prisma`
// client on purpose, never db().

export const TENANT_MODELS = new Set([
  'CheckIn',
  'Triage',
  'Referral',
  'Appointment',
  'ClinicalNote',
  'Message',
  'Payment',
  'SafetyAlert',
])

export class WorkspaceScopeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WorkspaceScopeError'
    this.status = 500
  }
}

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
])
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert'])
const UPDATE_OPS = new Set(['update', 'updateMany', 'upsert'])
const KNOWN_OPS = new Set([...WHERE_OPS, ...CREATE_OPS])

function scopeOf(ctx) {
  if (!ctx || typeof ctx !== 'object' || !('orgId' in ctx)) {
    throw new WorkspaceScopeError('db() needs the request workspace context (req.ctx).')
  }
  return ctx.orgId ?? null
}

// Prisma create data comes in two styles that can't be mixed: plain
// foreign-key columns (userId: '...') or relation objects
// (user: { connect: { id } }). Stamp the workspace in the same style.
// A nested `create` of child rows (answers: { create: [...] }) is allowed in
// both styles, so only `connect` / `connectOrCreate` mark the relation style.
function usesRelationStyle(data) {
  return Object.values(data).some(
    (v) =>
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Date) &&
      ('connect' in v || 'connectOrCreate' in v)
  )
}

function stampCreate(data, orgId, model) {
  if (data == null) return data
  if (data.organization !== undefined || (data.organizationId !== undefined && data.organizationId !== orgId)) {
    throw new WorkspaceScopeError(`Refused to create a ${model} in another workspace.`)
  }
  const { organizationId: _ignored, ...rest } = data
  if (orgId === null) return rest
  if (usesRelationStyle(rest)) return { ...rest, organization: { connect: { id: orgId } } }
  return { ...rest, organizationId: orgId }
}

function guardUpdate(data, model) {
  if (data && (data.organizationId !== undefined || data.organization !== undefined)) {
    throw new WorkspaceScopeError(`Refused to move a ${model} between workspaces.`)
  }
}

function build(orgId) {
  return prisma.$extends({
    name: `workspace-${orgId ?? 'mindora-care'}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args)
          if (!KNOWN_OPS.has(operation)) {
            throw new WorkspaceScopeError(`${model}.${operation} is not allowed through db().`)
          }

          const next = { ...(args ?? {}) }

          if (WHERE_OPS.has(operation)) {
            next.where = { ...(next.where ?? {}), organizationId: orgId }
          }

          if (UPDATE_OPS.has(operation)) {
            guardUpdate(operation === 'upsert' ? next.update : next.data, model)
          }

          if (operation === 'create') {
            next.data = stampCreate(next.data, orgId, model)
          } else if (operation === 'upsert') {
            next.create = stampCreate(next.create, orgId, model)
          } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const rows = Array.isArray(next.data) ? next.data : [next.data]
            // createMany only takes plain columns, so stamping uses organizationId.
            next.data = rows.map((row) => stampCreate(row, orgId, model))
          }

          return query(next)
        },
      },
    },
  })
}

// One extended client per scope, reused across requests.
const clients = new Map()

export function db(ctx) {
  const orgId = scopeOf(ctx)
  const key = orgId ?? 'mindora-care'
  let client = clients.get(key)
  if (!client) {
    client = build(orgId)
    clients.set(key, client)
  }
  return client
}
