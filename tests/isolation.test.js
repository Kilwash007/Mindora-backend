import './setup.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { app } from '../src/app.js'
import { prisma } from '../src/lib/prisma.js'
import { buildWorld } from './fixtures.js'
import { getRoutes, paramsOf, fill } from './routes.js'

// Workspace isolation, through the real HTTP routes.
//
// Every signed-in actor (patient, clinician and owner in workspaces A and B,
// patient and clinician in Mindora Care, and a Mindora platform admin) calls
// every GET route in the app:
//   - routes without parameters: the response must not contain anything
//     from another scope (no ids, no tagged names or text);
//   - routes with parameters (/:id, /:userId ...): each is called with every
//     id from the other scopes, and must not return that scope's data.
// Mindora admins act in Mindora Care, so workspaces A and B are foreign to
// them. The one exception is Mindora's Organizations pages
// (/api/admin/organizations), which by design show each workspace's name and
// member totals: there, only the workspace's people and records count as a
// leak. Each failure names the route and what leaked.
//
// ISOLATION_REPORT=<path> also writes the full list of leaks to that file.

let server
let base
let world
let routes
const allLeaks = []

// Each request comes from a different documentation-range address, so the
// per-IP rate limits never trip during the sweep. Only the test server sees
// this header; it is trusted because the request comes from this machine.
let ipCounter = 0
function nextIp() {
  ipCounter += 1
  return `198.18.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`
}

async function get(path, token) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': nextIp() },
  })
  const text = await res.text()
  return { status: res.status, text }
}

const PLATFORM_VIEW = /^\/api\/admin\/organizations(\/|$)/

function leaksIn(text, foreignScopes, platformView = false) {
  const found = []
  for (const scope of foreignScopes) {
    for (const marker of platformView ? scope.recordMarkers : scope.markers) {
      if (text.includes(marker)) {
        found.push(`${scope.key === 'care' ? 'Mindora Care' : `workspace ${scope.key}`} data`)
        break
      }
    }
  }
  return found
}

async function sweep(actorLabel, token, ownKey, isMindoraAdmin = false) {
  const foreign = Object.values(world.scopes).filter((s) => s.key !== ownKey)
  const foreignIds = foreign.flatMap((s) => s.ids)
  const leaks = []

  for (const path of routes) {
    const params = paramsOf(path)
    const platformView = isMindoraAdmin && PLATFORM_VIEW.test(path)
    if (params.length === 0) {
      const { status, text } = await get(path, token)
      if (status < 400) {
        for (const what of leaksIn(text, foreign, platformView)) leaks.push({ actor: actorLabel, route: `GET ${path}`, status, what })
      }
      continue
    }
    for (const id of foreignIds) {
      const { status, text } = await get(fill(path, id), token)
      if (status >= 400) continue
      const found = leaksIn(text, foreign, platformView)
      if (found.length) {
        leaks.push({ actor: actorLabel, route: `GET ${path}`, status, what: found.join(', ') })
        break
      }
    }
  }
  return leaks
}

function describe(leaks) {
  return leaks.map((l) => `  ${l.route}  (${l.status})  shows ${l.what}`).join('\n')
}

test.before(async () => {
  world = await buildWorld()
  routes = getRoutes()
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
  console.log(`# sweeping ${routes.length} GET routes`)
})

test.after(async () => {
  if (process.env.ISOLATION_REPORT) {
    const lines = [`Isolation sweep, ${new Date().toISOString()}`, `${allLeaks.length} leak(s)`, '']
    for (const l of allLeaks) lines.push(`${l.actor} | GET ${l.route.slice(4)} | ${l.status} | ${l.what}`)
    writeFileSync(process.env.ISOLATION_REPORT, lines.join('\n') + '\n')
  }
  server?.close()
  await prisma.$disconnect()
})

const ACTORS = [
  ['Workspace A patient', 'A', 'patient'],
  ['Workspace A clinician', 'A', 'clinician'],
  ['Workspace A owner', 'A', 'owner'],
  ['Workspace B patient', 'B', 'patient'],
  ['Workspace B clinician', 'B', 'clinician'],
  ['Workspace B owner', 'B', 'owner'],
  ['Mindora Care patient', 'care', 'patient'],
  ['Mindora Care clinician', 'care', 'clinician'],
  ['Mindora platform admin', 'care', 'admin'],
]

for (const [label, scopeKey, role] of ACTORS) {
  test(`${label} sees nothing from other workspaces`, async () => {
    const token = role === 'admin' ? world.mindoraAdmin : world.scopes[scopeKey].actors[role]
    const leaks = await sweep(label, token, scopeKey, role === 'admin')
    allLeaks.push(...leaks)
    assert.equal(leaks.length, 0, `${label} can see other workspaces' data:\n${describe(leaks)}`)
  })
}
