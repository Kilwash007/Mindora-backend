import { authRouter } from '../src/routes/auth.routes.js'
import { referralRouter } from '../src/routes/referral.routes.js'
import { checkInRouter } from '../src/routes/checkin.routes.js'
import { adminRouter } from '../src/routes/admin.routes.js'
import { professionalRouter } from '../src/routes/professional.routes.js'
import { appointmentRouter } from '../src/routes/appointment.routes.js'
import { clientRouter } from '../src/routes/client.routes.js'
import { documentRouter } from '../src/routes/document.routes.js'
import { institutionRouter } from '../src/routes/institution.routes.js'
import { aiRouter } from '../src/routes/ai.routes.js'
import { accountRouter } from '../src/routes/account.routes.js'
import { reviewRouter } from '../src/routes/review.routes.js'
import { messageRouter } from '../src/routes/message.routes.js'
import { groupRouter } from '../src/routes/group.routes.js'
import { paymentRouter } from '../src/routes/payment.routes.js'
import { studentRateRouter } from '../src/routes/studentRate.routes.js'
import { kcbIpnRouter } from '../src/routes/kcbIpn.routes.js'
import { pricesRouter } from '../src/routes/v1/prices.js'
import { screeningsRouter } from '../src/routes/v1/screenings.js'
import { meRouter } from '../src/routes/v1/me.js'
import { triageRouter } from '../src/routes/v1/triage.js'
import { bookingRouter } from '../src/routes/v1/booking.js'
import { clinicianRouter } from '../src/routes/v1/clinician.js'
import { adminTriageRouter } from '../src/routes/v1/adminTriage.js'
import { organizationAdminRouter } from '../src/routes/organization.routes.js'
import { orgRouter } from '../src/routes/org.routes.js'
import { inviteRouter } from '../src/routes/invite.routes.js'

// Same mount points as src/app.js. If a router is added there, add it here
// too, so the sweep covers it.
const MOUNTS = [
  ['/api/auth', authRouter],
  ['/api/admin/organizations', organizationAdminRouter],
  ['/api/org', orgRouter],
  ['/api/invites', inviteRouter],
  ['/api/referrals', referralRouter],
  ['/api/check-ins', checkInRouter],
  ['/api/admin', adminRouter],
  ['/api/professionals', professionalRouter],
  ['/api/appointments', appointmentRouter],
  ['/api/clients', clientRouter],
  ['/api/documents', documentRouter],
  ['/api/institutions', institutionRouter],
  ['/api/ai', aiRouter],
  ['/api/account', accountRouter],
  ['/api/reviews', reviewRouter],
  ['/api/messages', messageRouter],
  ['/api/groups', groupRouter],
  ['/api/payments/kcb', kcbIpnRouter],
  ['/api/payments', paymentRouter],
  ['/api/student-rate', studentRateRouter],
  ['/api/v1/prices', pricesRouter],
  ['/api/v1/screenings', screeningsRouter],
  ['/api/v1/me', meRouter],
  ['/api/v1/triage', triageRouter],
  ['/api/v1/appointments', bookingRouter],
  ['/api/v1/clinician', clinicianRouter],
  ['/api/v1/admin/triage', adminTriageRouter],
]

// GET routes the sweep leaves out, because they reach outside the database
// (file storage, M-Pesa or KCB) rather than because they are safe.
const SKIP = [/\/file$/, /^\/api\/payments\/appointment\//, /^\/api\/payments\/kcb\//, /^\/api\/ai\//]

// Every GET route in the app, as full paths like '/api/v1/triage/:id'.
export function getRoutes() {
  const routes = []
  for (const [prefix, router] of MOUNTS) {
    for (const layer of router.stack) {
      const route = layer.route
      if (!route || !route.methods?.get || typeof route.path !== 'string') continue
      const path = (prefix + (route.path === '/' ? '' : route.path)) || prefix
      if (SKIP.some((re) => re.test(path))) continue
      routes.push(path)
    }
  }
  return [...new Set(routes)].sort()
}

export function paramsOf(path) {
  return [...path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1])
}

export function fill(path, value) {
  return path.replace(/:([A-Za-z_]+)/g, value)
}
