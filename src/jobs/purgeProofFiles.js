import { purgeReviewedProofFiles } from '../lib/proofFiles.js'

// Runs inside the server like the other jobs: guarded against overlapping
// runs and never allowed to take the API down.
const CHECK_INTERVAL_MS = 30 * 60 * 1000
let isRunning = false

async function tick() {
  if (isRunning) return
  isRunning = true
  try {
    const { deleted, failed } = await purgeReviewedProofFiles()
    if (deleted || failed) console.log(`[proof files] deleted ${deleted}, failed ${failed}`)
  } catch (err) {
    // Usually the free-tier database waking up (Prisma P1001): wait for the next run.
    console.warn(
      `[proof files] could not check (${err.code || err.name}): ${String(err.message).split('\n').filter(Boolean).pop()} — will retry next check`
    )
  } finally {
    isRunning = false
  }
}

export function startPurgeProofFilesJob() {
  setTimeout(tick, 60 * 1000)
  setInterval(tick, CHECK_INTERVAL_MS)
  console.log('[proof files] deletion job started')
}
