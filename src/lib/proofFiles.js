import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from './prisma.js'

// Photos of IDs sent as proof of being a student are deleted a set time after
// a person has reviewed them. The decision (approved or not, by whom and when)
// stays on record. The image has no further use, and it is the most damaging
// thing to lose in a breach.
//
// How long they are kept after review is PROOF_FILE_KEEP_DAYS (default 7, so a
// reviewer can look again if a decision is queried; 0 means as soon as the
// next check runs). Deletion cannot be undone.

export const DEFAULT_KEEP_DAYS = 7

export function keepDaysFromEnv(raw = process.env.PROOF_FILE_KEEP_DAYS) {
  if (raw === undefined || raw === '') return DEFAULT_KEEP_DAYS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_KEEP_DAYS
}

let r2 = null
export async function deleteProofFile(key) {
  r2 ??= new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })
  await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }))
}

// Deletes the files of reviewed requests that are past the keep period, then
// clears filePath. A file that fails to delete is left for the next run.
// onlyIds limits the check (used by tests).
export async function purgeReviewedProofFiles({
  now = new Date(),
  keepDays = keepDaysFromEnv(),
  deleteFile = deleteProofFile,
  onlyIds,
  client = prisma,
} = {}) {
  const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000)

  const due = await client.studentRateVerification.findMany({
    where: {
      filePath: { not: null },
      status: { in: ['APPROVED', 'REJECTED'] },
      OR: [{ reviewedAt: { lte: cutoff } }, { reviewedAt: null, createdAt: { lte: cutoff } }],
      ...(onlyIds ? { id: { in: onlyIds } } : {}),
    },
    select: { id: true, filePath: true },
    take: 100,
  })

  const result = { deleted: 0, failed: 0 }
  for (const v of due) {
    try {
      await deleteFile(v.filePath)
      await client.studentRateVerification.update({ where: { id: v.id }, data: { filePath: null } })
      result.deleted += 1
    } catch (err) {
      result.failed += 1
      console.error(`[proof files] could not delete the file for request ${v.id}:`, err.message)
    }
  }
  return result
}
