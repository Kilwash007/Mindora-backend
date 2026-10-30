import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM_ADDRESS = 'Mindora <no-reply@send.mindora.africa>'

export async function sendOtpEmail(to, code) {
  await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Your Mindora login code',
    html: `
      <div style="font-family: sans-serif; max-width: 480px;">
        <h2 style="color: #0f1e3d;">Your Mindora login code</h2>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #0f1e3d;">${code}</p>
        <p style="color: #565d70;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  })
}

export async function sendPasswordResetEmail(to, code) {
  await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Your Mindora password reset code',
    html: `
      <div style="font-family: sans-serif; max-width: 480px;">
        <h2 style="color: #0f1e3d;">Reset your Mindora password</h2>
        <p style="color: #565d70;">Enter this code on the reset page to choose a new password:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #0f1e3d;">${code}</p>
        <p style="color: #565d70;">This code expires in 10 minutes. If you didn't ask to reset your password, you can safely ignore this email and your password will stay the same.</p>
      </div>
    `,
  })
}

export async function sendAppointmentReminderEmail(to, { professionalName, scheduledFor, type, meetingUrl }) {
  const when = new Date(scheduledFor).toLocaleString('en-KE', {
    dateStyle: 'full',
    timeStyle: 'short',
  })

  const joinLine = type === 'ONLINE' && meetingUrl
    ? `<p>Your session link: <a href="${meetingUrl}">${meetingUrl}</a> (becomes active 10 minutes before your appointment).</p>`
    : '<p>This is an in-person appointment.</p>'

  await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Reminder: your Mindora appointment with ${professionalName} tomorrow`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px;">
        <h2 style="color: #0f1e3d;">Appointment reminder</h2>
        <p>You have an upcoming session with <strong>${professionalName}</strong>.</p>
        <p style="font-size: 18px; font-weight: bold; color: #0f1e3d;">${when}</p>
        ${joinLine}
        <p style="color: #565d70; font-size: 13px;">If you need to reschedule or cancel, please contact Mindora support.</p>
      </div>
    `,
  })
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Tells a clinician a triage is waiting. It says nothing about the patient:
// email is not a safe place for health information, so the details stay in
// the portal. EMAIL_DISABLED=true skips sending (used by local tests).
export async function sendTriageQueuedEmail(to, { name, urgent, assigned }) {
  if (process.env.EMAIL_DISABLED === 'true') return

  const base = (process.env.PRO_PORTAL_URL || '').replace(/\/$/, '')
  const link = base
    ? `<p><a href="${base}/pro/triage">Open the triage queue</a></p>`
    : '<p>Sign in to your Mindora professional portal and open <strong>Triage</strong>.</p>'
  const why = assigned
    ? 'A new triage has been assigned to you.'
    : 'Nobody is on call for triage right now, so this was sent to every clinician who can take it. Open the queue and choose <strong>Take this triage</strong>, or switch yourself on call.'

  await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: urgent ? 'Urgent: a triage is waiting' : 'A triage is waiting',
    html: `
      <div style="font-family: sans-serif; max-width: 480px;">
        <h2 style="color: #0f1e3d;">${urgent ? 'Urgent triage waiting' : 'A triage is waiting'}</h2>
        <p>Hello ${escapeHtml(name)},</p>
        <p>${why}</p>
        ${urgent ? '<p><strong>This one is urgent. Please look at it as soon as you can.</strong></p>' : ''}
        ${link}
        <p style="color: #565d70; font-size: 13px;">Patients are told to expect a first reply within 2 hours, between 8am and 8pm EAT. No patient details are sent by email.</p>
      </div>
    `,
  })
}
