import { z } from 'zod'
import { SCREENING_QUESTIONS, TOTAL_QUESTION_COUNT } from './screening.js'

const QUESTION_BY_ID = new Map(SCREENING_QUESTIONS.map((q) => [q.id, q]))

export const answersSchema = z.object({
  answers: z
    .array(
      z.object({
        domain: z.string(),
        questionId: z.string(),
        value: z.number().int().min(0).max(3),
      })
    )
    .length(TOTAL_QUESTION_COUNT),
})

// Confirms the submitted answers are exactly the real screening questions:
// no fewer, no duplicates, no made-up questionIds, and each value fits its
// instrument's scale (PHQ-9/GAD-7 are 0-3, CAGE-AID is yes/no, 0-1).
export function validateAnswersShape(answers) {
  const seen = new Set()
  for (const a of answers) {
    const question = QUESTION_BY_ID.get(a.questionId)
    if (!question) return `Unknown question: ${a.questionId}`
    if (seen.has(a.questionId)) return `Duplicate answer for: ${a.questionId}`
    seen.add(a.questionId)
    const maxForScale = question.scale === 'yesno' ? 1 : 3
    if (a.value > maxForScale) return `Invalid value for ${a.questionId}`
  }
  if (seen.size !== TOTAL_QUESTION_COUNT) return 'Missing one or more required questions.'
  return null
}
