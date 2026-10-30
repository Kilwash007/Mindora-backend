import { Router } from 'express'
import { pricesRouter } from './prices.js'
import { screeningsRouter } from './screenings.js'
import { meRouter } from './me.js'
import { triageRouter } from './triage.js'
import { bookingRouter } from './booking.js'

// Versioned routes, so the web portals, WhatsApp and USSD can all use the
// same endpoints later.
export const v1Router = Router()

v1Router.use('/prices', pricesRouter)
v1Router.use('/screenings', screeningsRouter)
v1Router.use('/me', meRouter)
v1Router.use('/triage', triageRouter)
v1Router.use('/appointments', bookingRouter)
