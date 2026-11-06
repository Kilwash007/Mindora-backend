// M-Pesa STK Push for Mindora, through one of two providers:
//
//   daraja - Safaricom's Daraja API on Mindora's own Paybill (the original
//            integration, unchanged).
//   kcb    - KCB Buni "Mpesa Express": the prompt goes through KCB's shared
//            paybill 522522 with invoiceNumber TILL#REF, so the money lands
//            directly on Mindora Limited's KCB till / bank account.
//
// Both providers send their result to the same callback
// (/api/payments/callback in payment.routes.js) in the same Daraja-style
// shape (Body.stkCallback with CheckoutRequestID), so nothing else in the app
// needs to know which provider was used.
//
// Choosing the provider:
//   MPESA_PROVIDER=daraja (default) or kcb
//   KCB_TEST_PHONES=2547XXXXXXXX,...  optional: while MPESA_PROVIDER is
//     daraja, these numbers only are routed through KCB, so the KCB path
//     can be tested on the live API without touching real patients.
//
// KCB sandbox safety: while KCB_ENV is not 'production', every KCB prompt is
// sent for KCB_TEST_AMOUNT_KES (default 1), whatever the booking costs,
// because sandbox prompts move real money to Safaricom's test paybill.
//
// Nothing here trusts the frontend with money state. The frontend can ask us
// to *initiate* a push; only the provider's callback (payment.routes.js) is
// allowed to mark a payment as PAID.

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

// Kenyan numbers only, normalised to 2547XXXXXXXX / 2541XXXXXXXX (no +, no
// leading 0). Accepts 07XXXXXXXX, 7XXXXXXXX, 2547XXXXXXXX, +2547XXXXXXXX.
export function normalizeKenyanPhone(input) {
  const digits = String(input).replace(/\D/g, '')
  if (digits.startsWith('254') && digits.length === 12) return digits
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`
  if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return `254${digits}`
  return null // caller treats null as "invalid phone number"
}

function kcbTestPhones() {
  return (process.env.KCB_TEST_PHONES || '')
    .split(',')
    .map((p) => normalizeKenyanPhone(p.trim()))
    .filter(Boolean)
}

export function providerFor(phoneNumber) {
  if ((process.env.MPESA_PROVIDER || 'daraja').toLowerCase() === 'kcb') return 'kcb'
  if (kcbTestPhones().includes(phoneNumber)) return 'kcb'
  return 'daraja'
}

// ---------------------------------------------------------------------------
// Daraja (Safaricom) — unchanged behaviour
// ---------------------------------------------------------------------------

const DARAJA_ENV = process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox'
const DARAJA_BASE_URL =
  DARAJA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'

// Access tokens last about an hour; cached in memory and refreshed early.
// Fine for one backend instance; move to shared storage before running more.
let darajaToken = null
let darajaTokenExpiresAt = 0

async function getDarajaToken() {
  if (darajaToken && Date.now() < darajaTokenExpiresAt) return darajaToken

  const consumerKey = requireEnv('MPESA_CONSUMER_KEY')
  const consumerSecret = requireEnv('MPESA_CONSUMER_SECRET')
  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')

  const res = await fetch(`${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  })
  if (!res.ok) {
    throw new Error(`M-Pesa auth failed (${res.status}): ${await res.text()}`)
  }

  const data = await res.json()
  darajaToken = data.access_token
  darajaTokenExpiresAt = Date.now() + (Number(data.expires_in) - 120) * 1000
  return darajaToken
}

function timestampNow() {
  // Daraja wants YYYYMMDDHHmmss. Render's clock is correct.
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

async function darajaStkPush({ phoneNumber, amountKes, accountReference, description, callbackUrl }) {
  const shortcode = requireEnv('MPESA_SHORTCODE')
  const passkey = requireEnv('MPESA_PASSKEY')
  const timestamp = timestampNow()
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64')

  const token = await getDarajaToken()

  const res = await fetch(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amountKes),
      PartyA: phoneNumber,
      PartyB: shortcode,
      PhoneNumber: phoneNumber,
      CallBackURL: callbackUrl,
      AccountReference: accountReference.slice(0, 12), // Daraja caps this field
      TransactionDesc: description.slice(0, 13), // and this one
    }),
  })

  const data = await res.json().catch(() => null)

  if (!res.ok || data?.ResponseCode !== '0') {
    const message = data?.errorMessage || data?.ResponseDescription || `STK push failed (${res.status})`
    throw new Error(message)
  }

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
  }
}

// ---------------------------------------------------------------------------
// KCB Buni — Mpesa Express (STK push to Mindora's KCB till)
// ---------------------------------------------------------------------------

const KCB_IS_PRODUCTION = process.env.KCB_ENV === 'production'

function kcbBaseUrl() {
  if (process.env.KCB_BASE_URL) return process.env.KCB_BASE_URL.replace(/\/$/, '')
  if (KCB_IS_PRODUCTION) throw new Error('Missing required env var: KCB_BASE_URL (production)')
  return 'https://uat.buni.kcbgroup.com'
}

function kcbTokenUrls() {
  if (process.env.KCB_TOKEN_URL) return [process.env.KCB_TOKEN_URL]
  if (KCB_IS_PRODUCTION) return [`${kcbBaseUrl()}/token`]
  // The sandbox portal issues keys against this endpoint; the older /token
  // path on the API host is kept as a fallback.
  return ['https://accounts.buni.kcbgroup.com/oauth2/token', `${kcbBaseUrl()}/token`]
}

let kcbToken = null
let kcbTokenExpiresAt = 0

async function getKcbToken() {
  if (kcbToken && Date.now() < kcbTokenExpiresAt) return kcbToken

  const key = requireEnv('KCB_CONSUMER_KEY')
  const secret = requireEnv('KCB_CONSUMER_SECRET')
  const credentials = Buffer.from(`${key}:${secret}`).toString('base64')

  const errors = []
  for (const url of kcbTokenUrls()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
      const data = JSON.parse(text)
      if (!data.access_token) throw new Error('no access_token in response')
      kcbToken = data.access_token
      kcbTokenExpiresAt = Date.now() + (Number(data.expires_in || 3600) - 120) * 1000
      return kcbToken
    } catch (err) {
      errors.push(`${url}: ${err.message}`)
    }
  }
  throw new Error(`KCB auth failed (${errors.join(' | ')})`)
}

async function kcbStkPush({ phoneNumber, amountKes, accountReference, description, callbackUrl }) {
  const till = requireEnv('KCB_TILL_NUMBER').replace(/\D/g, '')
  const ref = String(accountReference).replace(/[^A-Za-z0-9]/g, '').slice(0, 20)

  const sendAmount = KCB_IS_PRODUCTION
    ? Math.round(amountKes)
    : Math.max(1, Math.round(Number(process.env.KCB_TEST_AMOUNT_KES || 1)))
  if (!KCB_IS_PRODUCTION) {
    console.warn(`[kcb] SANDBOX: sending KES ${sendAmount} instead of KES ${Math.round(amountKes)} for ${ref}`)
  }

  const token = await getKcbToken()

  const res = await fetch(`${kcbBaseUrl()}/mm/api/request/1.0.0/stkpush`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      routeCode: process.env.KCB_ROUTE_CODE || '207',
      operation: 'STKPush',
      messageId: `${Date.now()}_Mindora_${ref}`,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      phoneNumber,
      amount: String(sendAmount),
      invoiceNumber: `${till}#${ref}`,
      sharedShortCode: true,
      orgShortCode: '',
      orgPassKey: '',
      callbackUrl,
      transactionDescription: String(description || 'Mindora').slice(0, 40),
    }),
  })

  const data = await res.json().catch(() => null)
  const inner = data?.response || data
  const ok =
    res.ok &&
    String(data?.header?.statusCode ?? inner?.ResponseCode) === '0' &&
    inner?.CheckoutRequestID

  if (!ok) {
    const message =
      data?.header?.statusDescription ||
      inner?.ResponseDescription ||
      inner?.errorMessage ||
      data?.fault?.message ||
      `KCB STK push failed (${res.status})`
    throw new Error(message)
  }

  return {
    merchantRequestId: inner.MerchantRequestID,
    checkoutRequestId: inner.CheckoutRequestID,
  }
}

// ---------------------------------------------------------------------------
// Public entry point — same signature as before, used by payment.routes.js
// (appointments) and routes/v1/triage.js (triage).
// ---------------------------------------------------------------------------

// Initiates an STK Push. The result arrives later via callback; this only
// confirms the prompt was *sent*.
export async function initiateStkPush(args) {
  const provider = providerFor(args.phoneNumber)
  const result = provider === 'kcb' ? await kcbStkPush(args) : await darajaStkPush(args)
  console.log(`[mpesa] STK sent via ${provider}: ${result.checkoutRequestId}`)
  return { ...result, provider }
}
