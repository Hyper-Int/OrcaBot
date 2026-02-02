// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: bug-report-v3-fixes

/**
 * Bug Report Handler
 *
 * Processes bug reports from users and sends email notifications.
 */

import type { Env, User } from '../types';
import { sendEmail, buildBugReportEmail, type EmailAttachment } from '../email/resend';
import { checkRatеLimitByKey } from '../ratelimit/middleware';

const BUG_REPORT_EMAIL = 'rob.d.macrae@gmail.com';
const handlerRevision = 'bug-report-v3-fixes';

// Matches data:image/<type>;base64, and captures the image type
const DATA_URL_PREFIX_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/;
// Quick check that the remaining string is plausible base64
const BASE64_RE = /^[A-Za-z0-9+/\n\r]+=*$/;

const MAX_DECODED_BYTES = 5 * 1024 * 1024; // 5MB decoded

const IMAGE_TYPE_TO_EXT: Record<string, string> = {
  png: 'png',
  jpeg: 'jpeg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

interface BugReportData {
  notes?: string;
  screenshot?: string; // Base64 data URL
  dashboardId?: string;
  dashboardName?: string;
  userAgent?: string;
  url?: string;
}

interface ValidatedScreenshot {
  base64: string;
  ext: string;
}

/**
 * Validate and extract base64 content from a data URL.
 * Returns the raw base64 string + file extension, or null if invalid.
 */
function validateScreenshot(raw: string): ValidatedScreenshot | null {
  const prefixMatch = raw.match(DATA_URL_PREFIX_RE);
  if (!prefixMatch) {
    return null;
  }

  const imageType = prefixMatch[1]; // e.g. "png", "jpeg"
  const base64Content = raw.slice(prefixMatch[0].length);
  if (!base64Content || !BASE64_RE.test(base64Content)) {
    return null;
  }

  // Compute decoded byte size from base64 length
  // Each 4 base64 chars = 3 bytes, minus padding
  const stripped = base64Content.replace(/[\n\r]/g, '');
  const padding = stripped.endsWith('==') ? 2 : stripped.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor(stripped.length * 3 / 4) - padding;
  if (decodedBytes > MAX_DECODED_BYTES) {
    return null;
  }

  return {
    base64: base64Content,
    ext: IMAGE_TYPE_TO_EXT[imageType] || 'png',
  };
}

export async function submitBugReport(
  env: Env,
  user: User,
  data: BugReportData
): Promise<Response> {
  console.log(`[bug-reports] submitBugReport called at ${new Date().toISOString()}, revision: ${handlerRevision}`);

  // Per-user bug report rate limit (stricter than general API limit)
  const rateLimitResult = await checkRatеLimitByKey(`bugreport:${user.id}`, env);
  if (!rateLimitResult.allowed) {
    return rateLimitResult.response!;
  }

  const notes = typeof data.notes === 'string' ? data.notes.trim() : '';
  const dashboardId = data.dashboardId || 'N/A';
  const dashboardName = data.dashboardName || 'N/A';
  const userAgent = data.userAgent || 'N/A';
  const url = data.url || 'N/A';

  // Validate screenshot
  let validScreenshot: ValidatedScreenshot | null = null;
  let screenshotExcluded = false;
  if (data.screenshot && typeof data.screenshot === 'string') {
    validScreenshot = validateScreenshot(data.screenshot);
    if (!validScreenshot) {
      console.warn('[bug-reports] Screenshot excluded: invalid format or too large');
      screenshotExcluded = true;
    }
  }

  try {
    const email = buildBugReportEmail({
      userEmail: user.email,
      userName: user.name,
      notes,
      dashboardId,
      dashboardName,
      userAgent,
      url,
      hasScreenshot: Boolean(validScreenshot),
    });

    const attachments: EmailAttachment[] = [];
    if (validScreenshot) {
      attachments.push({
        filename: `screenshot-${Date.now()}.${validScreenshot.ext}`,
        content: validScreenshot.base64,
        encoding: 'base64',
      });
    }

    await sendEmail(env, {
      to: BUG_REPORT_EMAIL,
      subject: email.subject,
      html: email.html,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    console.log(`[bug-reports] Bug report sent successfully from ${user.email}`);
    return Response.json({
      success: true,
      screenshotIncluded: Boolean(validScreenshot),
      screenshotExcluded,
    }, { status: 201 });
  } catch (error) {
    console.error('[bug-reports] Failed to send bug report:', error);
    return Response.json({ error: 'Failed to submit bug report' }, { status: 500 });
  }
}
