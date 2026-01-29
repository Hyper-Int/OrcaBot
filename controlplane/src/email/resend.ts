// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Resend Email Service
 *
 * Simple email sending via Resend API for invitation emails.
 */

import type { Env } from '../types';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send an email via Resend API
 */
export async function sendEmail(env: Env, options: EmailOptions): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not configured, skipping email send');
    return;
  }

  const from = env.EMAIL_FROM || 'OrcaBot <noreply@orcabot.com>';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Failed to send email:', error);
    throw new Error(`Failed to send email: ${error}`);
  }
}

/**
 * Build invitation email content
 */
export function buildInvitationEmail(params: {
  inviterName: string;
  dashboardName: string;
  role: string;
  acceptUrl: string;
}): { subject: string; html: string } {
  return {
    subject: `${params.inviterName} invited you to "${params.dashboardName}" on OrcaBot`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #0066ff 0%, #0052cc 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">You've been invited!</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      <strong>${escapeHtml(params.inviterName)}</strong> has invited you to collaborate on
      <strong>"${escapeHtml(params.dashboardName)}"</strong> as a <strong>${escapeHtml(params.role)}</strong>.
    </p>

    <p style="margin: 24px 0;">
      <a href="${escapeHtml(params.acceptUrl)}"
         style="display: inline-block; padding: 14px 28px; background: #0066ff; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 16px;">
        Accept Invitation
      </a>
    </p>

    <p style="margin: 24px 0 0; color: #666; font-size: 14px;">
      This invitation will expire in 7 days. If you don't have an OrcaBot account yet,
      you'll be able to create one when you accept the invitation.
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot - Collaborative AI Coding Platform
  </p>
</body>
</html>
    `.trim(),
  };
}

/**
 * Build notification email for when an existing user is added to a dashboard
 */
export function buildAccessGrantedEmail(params: {
  inviterName: string;
  dashboardName: string;
  role: string;
  dashboardUrl: string;
}): { subject: string; html: string } {
  return {
    subject: `${params.inviterName} added you to "${params.dashboardName}" on OrcaBot`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #0066ff 0%, #0052cc 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">You've been added!</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      <strong>${escapeHtml(params.inviterName)}</strong> has added you to
      <strong>"${escapeHtml(params.dashboardName)}"</strong> as a <strong>${escapeHtml(params.role)}</strong>.
    </p>

    <p style="margin: 24px 0;">
      <a href="${escapeHtml(params.dashboardUrl)}"
         style="display: inline-block; padding: 14px 28px; background: #0066ff; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 16px;">
        Open Dashboard
      </a>
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot - Collaborative AI Coding Platform
  </p>
</body>
</html>
    `.trim(),
  };
}

/**
 * Build thank-you email for interest registration
 */
export function buildInterestThankYouEmail(): { subject: string; html: string } {
  return {
    subject: 'Thanks for your interest in OrcaBot!',
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #0066ff 0%, #0052cc 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">Thanks for your interest!</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      We've received your registration and we're excited that you're interested in OrcaBot!
    </p>

    <p style="margin: 16px 0; font-size: 16px;">
      We'll be in touch soon with updates on access and new features.
    </p>

    <p style="margin: 24px 0 0; color: #666; font-size: 14px;">
      In the meantime, feel free to reply to this email if you have any questions.
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot - Agentic AI Coding Agent Orchestration
  </p>
</body>
</html>
    `.trim(),
  };
}

/**
 * Build notification email for admin when someone registers interest
 */
export function buildInterestNotificationEmail(params: {
  email: string;
  note?: string;
}): { subject: string; html: string } {
  const noteSection = params.note
    ? `
    <div style="margin: 16px 0; padding: 16px; background: #f5f5f5; border-radius: 8px;">
      <p style="margin: 0 0 8px; font-size: 14px; color: #666; font-weight: 500;">Note from user:</p>
      <p style="margin: 0; font-size: 14px;">${escapeHtml(params.note)}</p>
    </div>`
    : '';

  return {
    subject: `New OrcaBot interest registration: ${params.email}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">New Interest Registration</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      Someone has registered their interest in OrcaBot:
    </p>

    <p style="margin: 16px 0; font-size: 16px;">
      <strong>Email:</strong> ${escapeHtml(params.email)}
    </p>
    ${noteSection}
    <p style="margin: 24px 0 0; color: #666; font-size: 14px;">
      Registered at: ${new Date().toISOString()}
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot Admin Notification
  </p>
</body>
</html>
    `.trim(),
  };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
