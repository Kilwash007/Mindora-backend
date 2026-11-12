import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { hashPassword } from '../lib/auth.js'
import { issueSession } from '../lib/session.js'
import { registerLimiter } from '../middleware/rateLimit.js'
import { audit } from '../lib/audit.js'
import { wrap, HttpError } from '../lib/wrap.js'
import { CURRENT_CONSENT_VERSION } from '../lib/consent.js'
import { PROFESSIONAL_TYPES } from '../lib/professionalTypes.js'
import { dateOfBirthField, dobToDate, isUnder18, UNDER_18_SIGNUP } from '../lib/age.js'
import { findUsableInvite, emailTaken, hashInviteToken, ROLE_ACCOUNT } from '../lib/invites.js'

// Opening and accepting a workspace invitation (Mindora for Institutions),
// mounted at /api/invites. No sign-in needed: the one-time link is the
// proof. Accepting creates the person's new account and their membership
// together, and signs them in.
//
//   GET  /:token          what the invitation is for
//   POST /:token/accept   create the account and join the workspace
//
// Patients give their date of birth (under 18 is refused, nothing stored,
// and the invitation stays usable) and consent, exactly as at sign-up.
// Clinicians choose their professional type; the licence number and expiry
// are the ones the institution vouched for when it invited them.

export const inviteRouter = Router()

const base = {
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(8),
}
const ACCEPT_SCHEMAS = {
  ORG_PATIENT: z.object({
    ...base,
    dateOfBirth: dateOfBirthField,
    consent: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the privacy consent to create an account.' }),
    }),
  }),
  ORG_CLINICIAN: z.object({ ...base, type: z.enum(PROFESSIONAL_TYPES) }),
  ORG_ADMIN: z.object(base),
  ORG_OWNER: z.object(base),
}

inviteRouter.get('/:token', wrap(async (req, res) => {
  const invite = await findUsableInvite(req.params.token)
  res.json({
    organization: { name: invite.organization.name, type: invite.organization.type },
    role: invite.role,
    accountType: ROLE_ACCOUNT[invite.role],
    email: invite.email,
    expiresAt: invite.expiresAt,
    licenceNumber: invite.licenceNumber,
    licenceExpiry: invite.licenceExpiry,
  })
}))

inviteRouter.post('/:token/accept', registerLimiter, wrap(async (req, res) => {
  const invite = await findUsableInvite(req.params.token)
  const parsed = ACCEPT_SCHEMAS[invite.role].safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const d = parsed.data

  // Checked before anything is stored; the invitation is left as it was.
  if (invite.role === 'ORG_PATIENT' && isUnder18(d.dateOfBirth)) {
    return res.status(403).json(UNDER_18_SIGNUP)
  }

  if (await emailTaken(prisma, invite.role, invite.email)) {
    throw new HttpError(
      409,
      'This email already has a Mindora account of this kind. Please ask for an invitation to a different email address.',
      'EMAIL_IN_USE'
    )
  }

  const passwordHash = await hashPassword(d.password)
  const accountRole = ROLE_ACCOUNT[invite.role]

  // Claiming the invitation and creating the account happen together, so two
  // clicks on the same link can never make two accounts.
  const account = await prisma.$transaction(async (tx) => {
    const claimed = await tx.organizationInvite.updateMany({
      where: {
        tokenHash: hashInviteToken(req.params.token),
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { acceptedAt: new Date() },
    })
    if (claimed.count === 0) throw new HttpError(410, 'This invitation has already been used. Please sign in instead.', 'INVITE_USED')

    const membership = { organizationId: invite.organizationId, role: invite.role }

    if (accountRole === 'user') {
      const user = await tx.user.create({
        data: {
          fullName: d.fullName,
          email: invite.email,
          passwordHash,
          dateOfBirth: dobToDate(d.dateOfBirth),
          consentAcceptedAt: new Date(),
          consentVersion: CURRENT_CONSENT_VERSION,
        },
      })
      await tx.organizationMembership.create({ data: { ...membership, userId: user.id } })
      return user
    }

    if (accountRole === 'professional') {
      // The institution vouches for its clinicians (licence number and
      // expiry), so they are verified within the workspace straight away.
      // They still accept the professional agreement at first sign-in.
      const professional = await tx.professional.create({
        data: { fullName: d.fullName, email: invite.email, passwordHash, type: d.type, verified: true },
      })
      await tx.organizationMembership.create({
        data: {
          ...membership,
          professionalId: professional.id,
          licenceNumber: invite.licenceNumber,
          licenceExpiry: invite.licenceExpiry,
        },
      })
      return professional
    }

    const orgAdmin = await tx.orgAdmin.create({ data: { fullName: d.fullName, email: invite.email, passwordHash } })
    await tx.organizationMembership.create({ data: { ...membership, orgAdminId: orgAdmin.id } })
    return orgAdmin
  })

  const session = await issueSession({
    id: account.id,
    role: accountRole,
    orgId: invite.organizationId,
    orgRole: invite.role,
  })

  await audit({
    actorType: accountRole,
    actorId: account.id,
    action: 'organization.invite.accept',
    resourceType: 'organization_invite',
    resourceId: invite.id,
    metadata: { role: invite.role },
    organizationId: invite.organizationId,
  })

  res.status(201).json({
    ...session,
    role: accountRole,
    account: { id: account.id, fullName: account.fullName, email: account.email },
    workspace: { id: invite.organization.id, name: invite.organization.name, role: invite.role },
  })
}))
