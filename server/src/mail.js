// Transactional email via Cloudflare's SMTP relay (smtp.mx.cloudflare.net).
// Real SMTP/TLS/MIME protocol work — not worth hand-rolling, same reasoning
// as web-push for the Web Push/VAPID protocol elsewhere in this project.
import nodemailer from "nodemailer";

let transporter = null;
let fromAddress = null;

/** Call once at startup. No-ops (with a warning) if SMTP isn't configured,
 * so the rest of the app still runs fine — reset emails just don't send,
 * and the link falls back to being logged server-side as before. */
export function initMail({ host, port, token, from }) {
  if (!host || !token || !from) {
    console.warn("[mail] SMTP not configured — password reset links will only be logged, not emailed.");
    return;
  }
  transporter = nodemailer.createTransport({
    host,
    port: Number(port) || 465,
    secure: true, // implicit TLS on 465 (smtps://)
    // Cloudflare's SMTP relay authenticates by API token, with the literal
    // username "api_token" — the token itself is the password.
    auth: { user: "api_token", pass: token },
  });
  fromAddress = from;
  console.log(`[mail] SMTP configured (${host}), sending as ${from}`);
}

export function mailReady() {
  return !!transporter;
}

async function sendRaw({ to, subject, html, text }) {
  if (!transporter) return false;
  // Temporary diagnostic: every real send funnels through here — logging
  // pid + subject + timestamp lets us tell apart "two separate processes
  // each sent one" from "one process sent two" the next time this fires,
  // without guessing from incomplete historical logs. Remove once the
  // double daily-email issue is root-caused.
  console.log(`[mail] sendRaw pid=${process.pid} to=${to} subject="${subject}" at ${new Date().toISOString()}`);
  await transporter.sendMail({ from: `"Ohm Sweet Ohm" <${fromAddress}>`, to, subject, html, text });
  return true;
}

export async function sendPasswordResetEmail(to, resetUrl) {
  return sendRaw({
    to,
    subject: "Reset your Ohm Sweet Ohm password",
    text: `Reset your Ohm Sweet Ohm admin password:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px;">
        <p>Someone (hopefully you) asked to reset the admin password for <strong>Ohm Sweet Ohm</strong>.</p>
        <p><a href="${resetUrl}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Reset password</a></p>
        <p style="color:#888;font-size:13px;">Or paste this link: <br>${resetUrl}</p>
        <p style="color:#888;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}

/** Used for the daily recap email — subject/html/text are pre-built by dailyEmail.js. */
export async function sendDailyReportEmail(to, subject, html, text) {
  return sendRaw({ to, subject, html, text });
}
