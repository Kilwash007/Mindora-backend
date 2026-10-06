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