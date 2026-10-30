import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { attachAuth } from './middleware/auth.js'
import { apiLimiter } from './middleware/rateLimit.js'
import { authRouter } from './routes/auth.routes.js'
import { referralRouter } from './routes/referral.routes.js'
import { checkInRouter } from './routes/checkin.routes.js'
import { adminRouter } from './routes/admin.routes.js'
import { professionalRouter } from './routes/professional.routes.js'
import { appointmentRouter } from './routes/appointment.routes.js'
import { clientRouter } from './routes/client.routes.js'
import { documentRouter } from './routes/document.routes.js'
import { institutionRouter } from './routes/institution.routes.js'
import { aiRouter } from './routes/ai.routes.js'
import { accountRouter } from './routes/account.routes.js'
import { startAppointmentReminderJob } from './jobs/appointmentReminders.js'
import { reviewRouter } from './routes/review.routes.js'
import { messageRouter } from './routes/message.routes.js'
import { groupRouter } from './routes/group.routes.js'
import { paymentRouter } from './routes/payment.routes.js'
import { studentRateRouter } from './routes/studentRate.routes.js'
import { v1Router } from './routes/v1/index.js'

// Process-level safety nets. A failed promise anywhere in the app (e.g. a
// background job losing the database connection) is logged instead of
// shutting the API down. A truly uncaught exception leaves the process in an
// unknown state, so we log it and exit; Render restarts the service.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled promise rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception, exiting:', err)
  process.exit(1)
})

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/,
// last updated by Cloudflare on 2023-09-28). Render routes all traffic to
// onrender.com through Cloudflare, so these sit between the visitor and us.
// If Cloudflare ever updates its list, update it here.
const CLOUDFLARE_RANGES = [
  // IPv4
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  // IPv6
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]

const app = express()

// Requests reach us as: visitor → Cloudflare → Render's internal proxies
// (private 10.x addresses) → this server. Trusting private ranges plus
// Cloudflare's ranges makes req.ip the first address outside both: the real
// visitor. Only Render's and Cloudflare's own machines are trusted, so a
// visitor can't fake their IP, and the login rate limiter depends on this
// to tell users apart.
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal', ...CLOUDFLARE_RANGES])

// CORS_ORIGIN can hold one address or several separated by commas, e.g.
// "https://patients.example.com,https://pro.example.com". A trailing slash
// on any entry is ignored, since browsers never send one.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean)

app.use(helmet())
app.use(
  cors({
    origin(origin, callback) {
      // Requests with no Origin header (health checks, curl) are not
      // browser cross-site requests, so they pass through.
      if (!origin) return callback(null, true)
      return callback(null, allowedOrigins.includes(origin))
    },
    credentials: true,
  })
)
app.use(express.json())
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))
app.use(attachAuth)
app.use('/api', apiLimiter)

// Root and health endpoints. The root route stops Render's own probes from
// showing up as 404s in the logs.
app.get('/', (_req, res) => res.json({ service: 'mindora-api', status: 'ok' }))
app.get('/health', (_req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV }))

app.use('/api/auth', authRouter)
app.use('/api/referrals', referralRouter)
app.use('/api/check-ins', checkInRouter)
app.use('/api/admin', adminRouter)
app.use('/api/professionals', professionalRouter)
app.use('/api/appointments', appointmentRouter)
app.use('/api/clients', clientRouter)
app.use('/api/documents', documentRouter)
app.use('/api/institutions', institutionRouter)
app.use('/api/ai', aiRouter)
app.use('/api/account', accountRouter)
app.use('/api/reviews', reviewRouter)
app.use('/api/messages', messageRouter)
app.use('/api/groups', groupRouter)
app.use('/api/payments', paymentRouter)
app.use('/api/student-rate', studentRateRouter)
app.use('/api/v1', v1Router)

// Centralised error handler — keeps stack traces out of prod responses.
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message,
  })
})

const port = process.env.PORT || 4000
app.listen(port, () => {
  console.log(`Mindora API listening on http://localhost:${port} [${process.env.NODE_ENV}]`)
  startAppointmentReminderJob()
})
