// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: blog-v1-subscriptions

import type { Env } from '../types';
import { sendEmail, buildBlogPostEmail } from '../email/resend';

const MODULE_REVISION = 'blog-v1-subscriptions';
console.log(`[blog] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Subscribe an email to blog notifications
 */
export async function subscribe(env: Env, email: string): Promise<Response> {
  if (!email || !email.includes('@')) {
    return Response.json({ error: 'E79501: Valid email is required' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const unsubscribeToken = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO blog_subscribers (id, email, unsubscribe_token) VALUES (?, ?, ?)`
    ).bind(id, email.toLowerCase(), unsubscribeToken).run();
  } catch (e: unknown) {
    // UNIQUE constraint = already subscribed
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return Response.json({ success: true, message: 'Already subscribed' });
    }
    throw e;
  }

  return Response.json({ success: true, message: 'Subscribed' }, { status: 201 });
}

/**
 * Unsubscribe via token (GET from email link)
 */
export async function unsubscribe(env: Env, token: string): Promise<Response> {
  if (!token) {
    return Response.json({ error: 'E79502: Token is required' }, { status: 400 });
  }

  const result = await env.DB.prepare(
    `DELETE FROM blog_subscribers WHERE unsubscribe_token = ?`
  ).bind(token).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    return new Response(unsubscribeHtml('Not found', 'This unsubscribe link is invalid or has already been used.'), {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(unsubscribeHtml('Unsubscribed', "You've been unsubscribed from OrcaBot blog updates."), {
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * Notify all subscribers about a new blog post (admin only)
 */
export async function notifySubscribers(env: Env, requestUrl: string, data: {
  title: string;
  description: string;
  slug: string;
}): Promise<Response> {
  const { title, description, slug } = data;
  if (!title || !slug) {
    return Response.json({ error: 'E79503: title and slug are required' }, { status: 400 });
  }

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  const cpOrigin = new URL(requestUrl).origin;
  const postUrl = `${frontendUrl}/blog#${slug.replace(/^\d{4}-\d{2}-\d{2}-/, '')}`;

  const subscribers = await env.DB.prepare(
    `SELECT email, unsubscribe_token FROM blog_subscribers`
  ).all<{ email: string; unsubscribe_token: string }>();

  let sent = 0;
  let failed = 0;

  for (const sub of subscribers.results) {
    const unsubscribeUrl = `${cpOrigin}/blog/unsubscribe?token=${sub.unsubscribe_token}`;
    const emailContent = buildBlogPostEmail({
      title,
      description: description || title,
      postUrl,
      unsubscribeUrl,
    });

    try {
      await sendEmail(env, {
        to: sub.email,
        subject: emailContent.subject,
        html: emailContent.html,
      });
      sent++;
    } catch (e) {
      console.error(`Failed to send blog notification to ${sub.email}:`, e);
      failed++;
    }
  }

  return Response.json({ success: true, sent, failed, total: subscribers.results.length });
}

function unsubscribeHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - OrcaBot</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0b1a2e; color: #fff;">
<div style="text-align: center; max-width: 400px; padding: 40px;">
<h1 style="font-size: 1.5rem; margin-bottom: 1rem;">${title}</h1>
<p style="color: #94a3b8;">${message}</p>
<a href="/" style="color: #3b82f6; text-decoration: none; margin-top: 2rem; display: inline-block;">Back to OrcaBot</a>
</div></body></html>`;
}
