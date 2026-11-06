import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'

// KCB Instant Payment Notification (IPN) for Mindora's till.
//
//   POST /api/payments/kcb/ipn
//
// KCB calls this whenever money reaches the till (STK payments and anyone
// paying the till directly). Each request carries a Signature header: a
// SHA256withRSA signature of the raw body made with KCB's private key, which
// we check with KCB's public key (KCB_IPN_PUBLIC_KEY).
//
// Signature rules:
//   - KCB_IPN_PUBLIC_KEY set: an invalid or missing signature is refused
//     (401) and nothing is stored.
//   - KCB_IPN_PUBLIC_KEY not set (sandbox, before KCB shares the key): the
//     notification is stored with signatureVerified = false and acknowledged,
//     so KCB's tests pass, but it is marked untrusted. In production
//     (KCB_ENV=production) a missing key is refused instead.
//
// This route never marks a payment PAID. The STK callback in
// payment.routes.js stays the only place that happens; an IPN is the bank's
// independent confirmation, linked to the Payment by M-Pesa receipt number.

export const kcbIpnRouter = Router()

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

function publicKeyPem() {
  const raw = (process.env.KCB_IPN_PUBLIC_KEY || '').trim()
  if (!raw) return null
  const unescaped = raw.replace(/\\n/g, '\n')
  if (unescaped.includes('BEGIN')) return unescaped
  const body = unescaped.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`
}

function verifySignature(rawBody, signature, pem) {
  if (!rawBody || !signature) return false
  try {
    return crypto.verify('RSA-SHA256', rawBody, pem, Buffer.from(signature, 'base64'))
  } catch (err) {
    console.error('[kcb ipn] signature check error:', err.message)
    return false
  }
}

function ackBody(header, transactionId, statusCode = '0', statusMessage = 'Notification received successfully') {
  return {
    header: {
      messageID: header?.messageID ?? '',
      originatorConversationID: header?.originatorConversationID ?? '',
      statusCode,
      statusMessage,
    },
    responsePayload: { transactionInfo: { transactionId: transactionId ?? '' } },
  }
}

function toKes(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

kcbIpnRouter.post('/ipn', wrap(async (req, res) => {
  const header = req.body?.header
  const data = req.body?.requestPayload?.additionalData?.notificationData
  const signature = req.get('Signature') || req.get('signature')

  const pem = publicKeyPem()
  let verified = false
  if (pem) {
    verified = verifySignature(req.rawBody, signature, pem)
    if (!verified) {
      console.error('[kcb ipn] REFUSED: bad or missing signature', { messageID: header?.messageID })
      return res.status(401).json(ackBody(header, '', '1', 'Invalid signature'))
    }
  } else if (process.env.KCB_ENV === 'production') {
    console.error('[kcb ipn] REFUSED: KCB_IPN_PUBLIC_KEY is not set in production')
    return res.status(503).json(ackBody(header, '', '1', 'Not configured'))
  } else {
    console.warn('[kcb ipn] KCB_IPN_PUBLIC_KEY not set: storing notification as UNVERIFIED (sandbox only)')
  }

  if (!data?.transactionID) {
    console.error('[kcb ipn] Unrecognised payload shape', JSON.stringify(req.body))
    return res.status(200).json(ackBody(header, '', '1', 'Unrecognised payload'))
  }

  const transactionId = String(data.transactionID)
  const amountKes = toKes(data.transactionAmt)

  const existing = await prisma.kcbIpnNotification.findUnique({ where: { transactionId } })
  if (existing) return res.status(200).json(ackBody(header, existing.id))

  const payment = await prisma.payment.findFirst({
    where: { mpesaReceiptNumber: transactionId },
    select: { id: true, amountKes: true },
  })

  const row = await prisma.kcbIpnNotification.create({
    data: {
      transactionId,
      messageId: header?.messageID ?? null,
      businessKey: data.businessKey ?? null,
      debitMsisdn: data.debitMSISDN ?? null,
      amountKes,
      currency: data.currency ?? null,
      transactionType: data.transactionType ?? null,
      narration: data.narration ?? null,
      transactionDate: data.transactionDate ?? null,
      signatureVerified: verified,
      matchedPaymentId: payment?.id ?? null,
      amountMatches: payment ? amountKes === payment.amountKes : null,
      rawBody: req.body,
    },
  })

  if (!payment) {
    console.warn('[kcb ipn] No payment matches receipt', transactionId, '(a direct till payment, or the callback has not arrived yet)')
  } else if (amountKes !== payment.amountKes) {
    console.error('[kcb ipn] AMOUNT MISMATCH', { paymentId: payment.id, expected: payment.amountKes, received: amountKes })
  }

  await audit({
    actorType: 'system',
    actorId: null,
    action: 'payment.kcb_ipn',
    resourceType: 'payment',
    resourceId: payment?.id ?? null,
    metadata: { ipnId: row.id, transactionId, amountKes, signatureVerified: verified },
  })

  res.status(200).json(ackBody(header, row.id))
}))
