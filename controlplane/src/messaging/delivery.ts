// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: messaging-delivery-v21-strip-cr
const MODULE_REVISION = 'messaging-delivery-v21-strip-cr';
console.log(`[messaging-delivery] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Message Delivery Module
 *
 * Delivers buffered inbound messages to sandbox PTYs.
 * If the sandbox VM is sleeping, wakes it first using ensureDashbоardSandbоx().
 *
 * Flow:
 * 1. Check if sandbox is running for the dashboard
 * 2. If not running: wake VM via ensureDashbоardSandbоx()
 * 3. Find or create a PTY for the connected terminal
 * 4. Drain all buffered messages to the PTY in chronological order
 * 5. Mark messages as delivered
 *
 * Reuses patterns from schedules/executor.ts for VM wake and PTY write.
 */

import type { Env, MessagingPolicy } from '../types';
import type { EnvWithDriveCache } from '../storage/drive-cache';
import { ensureDashbоardSandbоx } from '../sessions/handler';
import { SandboxClient } from '../sandbox/client';
import { createPtyToken } from '../auth/pty-token';
import { channelMatchesFilter } from './webhook-handler';

interface BufferedMessage {
  id: string;
  subscription_id: string;
  dashboard_id: string;
  provider: string;
  platform_message_id: string;
  sender_id: string | null;
  sender_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  message_text: string | null;
  message_metadata: string;
  status: string;
  delivery_attempts: number;
  delivered_terminals: string; // JSON array of terminal item IDs that already received this message
  created_at: string;
}

/**
 * Attempt to deliver buffered messages for a dashboard.
 * If the sandbox is not running, wakes it first.
 * Fans out to terminals connected to the messaging block that have an active
 * terminal_integration for the provider (policy gate — terminals without integration are skipped).
 *
 * Called from webhook-handler.ts via ctx.waitUntil() after buffering a message.
 *
 * @param messagingItemId - The messaging block's item_id (used to resolve connected terminals)
 * @param provider - The messaging provider (used to filter terminals by integration)
 */
export async function deliverOrWakeAndDrain(
  env: Env,
  dashboardId: string,
  messagingItemId: string,
  userId: string,
  provider: string,
): Promise<void> {
  // 1. Check for eligible terminals BEFORE waking the sandbox.
  // Terminals must be connected to this messaging block via an edge AND have an
  // active terminal_integration with an active policy for the provider.
  // This avoids waking VMs for dashboards with no connected terminals or no policies.
  const connectedTerminals = await env.DB.prepare(`
    SELECT DISTINCT de.target_item_id
    FROM dashboard_edges de
    JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
    JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL AND ti.active_policy_id IS NOT NULL
    WHERE de.source_item_id = ?
  `).bind(provider, messagingItemId).all<{ target_item_id: string }>();

  if (!connectedTerminals.results?.length) {
    console.log(`[delivery] No terminal with ${provider} integration+policy connected to messaging block ${messagingItemId} — messages stay buffered`);
    return;
  }

  // 2. Find the dashboard owner for VM wake (fallback if userId doesn't have access)
  let effectiveUserId = userId;
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, effectiveUserId).first<{ role: string }>();

  if (!access) {
    // Webhook user may not be a dashboard member — fall back to owner
    const owner = await env.DB.prepare(`
      SELECT user_id FROM dashboard_members
      WHERE dashboard_id = ? AND role = 'owner'
      LIMIT 1
    `).bind(dashboardId).first<{ user_id: string }>();

    if (!owner) {
      console.error(`[delivery] Dashboard ${dashboardId} has no owner — cannot wake sandbox`);
      return;
    }
    effectiveUserId = owner.user_id;
  }

  // 3. Ensure sandbox is running (wakes VM if sleeping)
  const envWithCache = env as EnvWithDriveCache;
  const sandboxResult = await ensureDashbоardSandbоx(envWithCache, dashboardId, effectiveUserId);

  if (sandboxResult instanceof Response) {
    console.error(`[delivery] Failed to ensure sandbox for dashboard ${dashboardId}`);
    return;
  }

  const { sandboxSessionId, sandboxMachineId } = sandboxResult;
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  // 4. Resolve PTY info for each connected terminal
  const terminalPtys: TerminalPty[] = [];
  for (const terminal of connectedTerminals.results) {
    try {
      const pty = await resolveTerminalPty(
        env, sandbox, dashboardId, terminal.target_item_id,
        effectiveUserId, sandboxSessionId, sandboxMachineId,
      );
      if (pty) terminalPtys.push(pty);
    } catch (err) {
      console.error(`[delivery] Failed to resolve PTY for terminal ${terminal.target_item_id}:`, err);
    }
  }

  if (!terminalPtys.length) {
    console.log(`[delivery] No active PTYs for dashboard ${dashboardId} — messages stay buffered`);
    return;
  }

  // 5. Claim and fan out buffered messages to all terminals
  await claimAndFanOut(env, sandbox, dashboardId, messagingItemId, provider, terminalPtys);
}

interface TerminalPty {
  terminalItemId: string;
  sessionId: string;
  ptyId: string;
  machineId: string;
}

/**
 * Resolve (or create) a PTY for a terminal, returning the connection info.
 */
async function resolveTerminalPty(
  env: Env,
  sandbox: SandboxClient,
  dashboardId: string,
  terminalItemId: string,
  effectiveUserId: string,
  sandboxSessionId: string,
  sandboxMachineId: string,
): Promise<TerminalPty | null> {
  const activeSession = await env.DB.prepare(`
    SELECT id, pty_id, sandbox_session_id, sandbox_machine_id
    FROM sessions
    WHERE item_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).bind(terminalItemId).first();

  if (activeSession?.pty_id) {
    return {
      terminalItemId,
      sessionId: activeSession.sandbox_session_id as string,
      ptyId: activeSession.pty_id as string,
      machineId: (activeSession.sandbox_machine_id as string) || sandboxMachineId,
    };
  }

  // Create a new PTY for message delivery
  const ptyId = crypto.randomUUID();
  const integrationToken = await createPtyToken(
    ptyId,
    sandboxSessionId,
    dashboardId,
    effectiveUserId,
    env.INTERNAL_API_TOKEN,
  );

  await sandbox.createPty(
    sandboxSessionId,
    'system',
    undefined, // No boot command
    sandboxMachineId,
    {
      ptyId,
      integrationToken,
    },
  );

  const newSessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, created_at)
    VALUES (?, ?, ?, ?, 'system', ?, ?, ?, 'active', ?)
  `).bind(
    newSessionId,
    dashboardId,
    terminalItemId,
    effectiveUserId,
    sandboxSessionId,
    sandboxMachineId,
    ptyId,
    now,
  ).run();

  console.log(`[delivery] Created PTY ${ptyId} for message delivery to terminal ${terminalItemId}`);

  return {
    terminalItemId,
    sessionId: sandboxSessionId,
    ptyId,
    machineId: sandboxMachineId,
  };
}

/**
 * Evaluate a single messaging policy against a buffered message.
 * Returns true if the policy permits the message.
 */
function policyAllowsMessage(policy: MessagingPolicy, msg: BufferedMessage): boolean {
  if (!policy.canReceive) return false;

  // Channel filter — uses resilient matching that cross-checks IDs/names
  if (policy.channelFilter) {
    if (policy.channelFilter.mode === 'allowlist') {
      const { channelIds, channelNames } = policy.channelFilter;
      const hasFilter = channelIds?.length || channelNames?.length;
      if (!hasFilter) return false; // Empty allowlist = deny
      if (!channelMatchesFilter(
        msg.channel_id || '', msg.channel_name || '', channelIds, channelNames,
      )) return false;
    }
    // mode: 'all' = no restriction
  }

  // Sender filter
  if (policy.senderFilter && policy.senderFilter.mode !== 'all') {
    const { mode, userIds, userNames } = policy.senderFilter;
    const senderIdMatch = userIds?.includes(msg.sender_id || '');
    const senderNameMatch = userNames?.some(n =>
      n.toLowerCase() === (msg.sender_name || '').toLowerCase()
    );
    if (mode === 'allowlist' && !senderIdMatch && !senderNameMatch) return false;
    if (mode === 'blocklist' && (senderIdMatch || senderNameMatch)) return false;
  }

  return true;
}

/**
 * Check which terminals are allowed to receive this message, per their individual policy.
 *
 * Previous implementation checked "any terminal allows → deliver to all terminals," which
 * leaked messages from a permissive terminal's policy to a restrictive terminal. Now each
 * terminal is evaluated independently.
 *
 * Returns:
 * - Map of terminalItemId → boolean (true = allowed by that terminal's policy)
 * - 'no_policy' if no policies found at all (temporary — keep buffered)
 * - 'all_denied' if policies exist but none permits (permanent — mark failed)
 */
async function checkPerTerminalPolicy(
  env: Env,
  msg: BufferedMessage,
  messagingItemId: string,
  terminalItemIds: string[],
): Promise<Map<string, boolean> | 'no_policy' | 'all_denied'> {
  // Load each terminal's policy individually so we can gate per-terminal delivery
  const terminalPolicies = await env.DB.prepare(`
    SELECT de.target_item_id AS terminal_item_id, ip.policy
    FROM dashboard_edges de
    JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
    JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL
    JOIN integration_policies ip ON ip.id = ti.active_policy_id
    WHERE de.source_item_id = ?
  `).bind(msg.provider, messagingItemId).all<{ terminal_item_id: string; policy: string }>();

  if (!terminalPolicies.results?.length) return 'no_policy';

  const result = new Map<string, boolean>();
  let anyAllowed = false;

  for (const terminalId of terminalItemIds) {
    // Find this terminal's policy row (there should be exactly one per terminal)
    const row = terminalPolicies.results.find(r => r.terminal_item_id === terminalId);
    if (!row) {
      // No policy for this terminal — deny (fail-closed)
      result.set(terminalId, false);
      continue;
    }

    let policy: MessagingPolicy;
    try {
      policy = JSON.parse(row.policy) as MessagingPolicy;
    } catch {
      result.set(terminalId, false);
      continue;
    }

    const allowed = policyAllowsMessage(policy, msg);
    result.set(terminalId, allowed);
    if (allowed) anyAllowed = true;
  }

  return anyAllowed ? result : 'all_denied';
}

/**
 * Claim buffered messages and fan out to all connected terminal PTYs.
 *
 * Flow: claim each message (status → delivering), re-validate policy, write to PTYs, then mark delivered.
 * The claim prevents concurrent workers from double-processing the same message,
 * while the fan-out ensures every connected terminal receives it.
 *
 * Per-terminal tracking: delivered_terminals (JSON array) tracks which terminals
 * already received the message. On partial failure + retry, only the remaining
 * terminals are attempted, preventing duplicate delivery.
 */
async function claimAndFanOut(
  env: Env,
  sandbox: SandboxClient,
  dashboardId: string,
  messagingItemId: string,
  provider: string,
  terminalPtys: TerminalPty[],
): Promise<void> {
  // Select buffered messages from ACTIVE subscriptions connected to this messaging block.
  // Filter by provider to prevent cross-provider leakage: if a single messaging block
  // has subscriptions for multiple providers (e.g., Slack + Discord), we must only deliver
  // messages from the provider whose terminals we resolved, not mix them.
  // Also filter out expired messages (expires_at <= now) to enforce retention contract —
  // without this, an expired message could be delivered if a new webhook arrives before
  // the cleanup cron runs.
  //
  // As a side effect, mark any expired-but-still-buffered messages so the cleanup cron
  // doesn't need to re-scan them.
  await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'expired'
    WHERE dashboard_id = ? AND status = 'buffered' AND expires_at <= datetime('now')
  `).bind(dashboardId).run();

  const messages = await env.DB.prepare(`
    SELECT im.* FROM inbound_messages im
    JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
    WHERE im.dashboard_id = ? AND im.status = 'buffered'
      AND im.provider = ?
      AND ms.item_id = ?
      AND ms.status = 'active'
      AND im.expires_at > datetime('now')
    ORDER BY im.created_at ASC
    LIMIT 50
  `).bind(dashboardId, provider, messagingItemId).all<BufferedMessage>();

  if (!messages.results?.length) {
    return;
  }

  console.log(`[delivery] Fanning out ${messages.results.length} messages to ${terminalPtys.length} terminal(s) for dashboard ${dashboardId}`);

  for (const msg of messages.results) {
    try {
      // Atomically claim message — prevents concurrent workers from double-processing
      // Set claimed_at so the stuck-delivery watchdog can distinguish fresh claims from old ones
      const claim = await env.DB.prepare(`
        UPDATE inbound_messages
        SET status = 'delivering', delivery_attempts = delivery_attempts + 1, claimed_at = datetime('now')
        WHERE id = ? AND status = 'buffered'
      `).bind(msg.id).run();

      if (!claim.meta?.changes) {
        console.log(`[delivery] Message ${msg.id} already claimed by another worker — skipping`);
        continue;
      }

      // delivery_attempts was incremented in DB by the claim above.
      // Use post-increment value for consistent retry limit checks (matches watchdog's < 3).
      const attemptsAfterClaim = msg.delivery_attempts + 1;

      // Re-validate against current per-terminal policies — catches policy changes since buffering.
      // Each terminal is evaluated independently: a permissive Terminal A can't cause messages
      // to leak to a restrictive Terminal B.
      const allTerminalIds = terminalPtys.map(p => p.terminalItemId);
      const policyResult = await checkPerTerminalPolicy(env, msg, messagingItemId, allTerminalIds);
      if (policyResult === 'all_denied') {
        console.log(`[delivery] Message ${msg.id} denied by all terminal policies — dropping`);
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = 'failed' WHERE id = ?
        `).bind(msg.id).run();
        continue;
      }
      if (policyResult === 'no_policy') {
        // No policy configured yet — reset to buffered so message isn't lost.
        // Also roll back delivery_attempts so retryBufferedMessages (which filters
        // delivery_attempts < 3) keeps picking it up. Without this rollback,
        // 3 no-policy cycles would strand the message as permanently buffered.
        console.log(`[delivery] Message ${msg.id} has no policy configured — keeping buffered`);
        await env.DB.prepare(`
          UPDATE inbound_messages
          SET status = 'buffered', claimed_at = NULL, delivery_attempts = delivery_attempts - 1
          WHERE id = ?
        `).bind(msg.id).run();
        continue;
      }

      // Parse which terminals already received this message (from previous partial delivery)
      let alreadyDelivered: Set<string>;
      try {
        alreadyDelivered = new Set(JSON.parse(msg.delivered_terminals || '[]') as string[]);
      } catch {
        alreadyDelivered = new Set();
      }

      // Only deliver to terminals whose individual policy allows AND haven't already received
      const remainingPtys = terminalPtys.filter(p =>
        !alreadyDelivered.has(p.terminalItemId) && policyResult.get(p.terminalItemId) === true
      );
      if (!remainingPtys.length) {
        // All terminals already received — mark as delivered
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?
        `).bind(msg.id).run();
        continue;
      }

      // Format message once, write to remaining terminal PTYs
      const formattedMessage = formatMessageForPty(msg);
      const newlyDelivered: string[] = [];
      const failedTerminals: string[] = [];

      for (const pty of remainingPtys) {
        try {
          await sandbox.writePty(pty.sessionId, pty.ptyId, formattedMessage, pty.machineId);
          newlyDelivered.push(pty.terminalItemId);
        } catch (err) {
          console.error(`[delivery] Failed to write message ${msg.id} to terminal ${pty.terminalItemId}:`, err);
          failedTerminals.push(pty.terminalItemId);
        }
      }

      // Merge newly delivered with previously delivered
      const allDeliveredTerminals = [...alreadyDelivered, ...newlyDelivered];

      if (!failedTerminals.length) {
        // All remaining terminals succeeded — mark as fully delivered
        await env.DB.prepare(`
          UPDATE inbound_messages
          SET status = 'delivered', delivered_at = datetime('now'), delivered_terminals = ?
          WHERE id = ?
        `).bind(JSON.stringify(allDeliveredTerminals), msg.id).run();
      } else {
        // Some terminals failed — save progress and reset for retry (or fail if exhausted)
        const newStatus = attemptsAfterClaim >= 3 ? 'failed' : 'buffered';
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = ?, delivered_terminals = ? WHERE id = ?
        `).bind(newStatus, JSON.stringify(allDeliveredTerminals), msg.id).run();

        if (newStatus === 'buffered') {
          console.log(`[delivery] Message ${msg.id}: ${newlyDelivered.length} delivered, ${failedTerminals.length} failed — will retry for remaining`);
        }
      }
    } catch (err) {
      console.error(`[delivery] Failed to deliver message ${msg.id}:`, err);
      const attemptsAfterClaim = msg.delivery_attempts + 1;
      const newStatus = attemptsAfterClaim >= 3 ? 'failed' : 'buffered';
      await env.DB.prepare(`
        UPDATE inbound_messages SET status = ? WHERE id = ?
      `).bind(newStatus, msg.id).run();
    }
  }
}

/**
 * Strip ANSI escape sequences and other terminal control characters from untrusted text.
 *
 * Prevents injection of terminal commands, cursor manipulation, or visual spoofing
 * when writing inbound messages from external platforms into PTYs.
 *
 * Strips:
 * - CSI sequences: ESC [ ... (final byte 0x40–0x7E)
 * - OSC sequences: ESC ] ... (terminated by ST or BEL)
 * - Two-byte ESC sequences: ESC followed by a single char (e.g., ESC D, ESC M)
 * - Raw control chars: \x00–\x08, \x0B–\x0C, \x0E–\x1F, \x7F (preserves \t and \n only)
 * - Carriage returns (\r / 0x0D): can overwrite prior lines in PTY, spoof prompts
 */
function stripAnsiAndControlChars(text: string): string {
  return text
    // CSI sequences: ESC [ (params) (intermediate) final
    .replace(/\x1b\[[0-9;]*[A-Za-z@-~]/g, '')
    // OSC sequences: ESC ] ... (terminated by ESC \ or BEL)
    .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, '')
    // Two-byte ESC sequences: ESC + single char
    .replace(/\x1b[^[\]]/g, '')
    // Remaining raw ESC characters
    .replace(/\x1b/g, '')
    // Control chars except \t (0x09) and \n (0x0A). Includes \r (0x0D) which can
    // overwrite prior lines in a PTY to spoof prompts or hide content.
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

/**
 * Format an inbound message for display in the PTY.
 *
 * All untrusted fields (sender name, channel name, message text) are sanitized
 * to strip ANSI escape sequences and terminal control characters.
 *
 * Format:
 * [INBOUND from Slack #general]
 * From: @alice (Alice Smith)
 * Channel: #general
 * Message: Can you review the PR?
 * ---
 * Reply with slack_reply_thread tool.
 */
function formatMessageForPty(msg: BufferedMessage): string {
  const provider = msg.provider.charAt(0).toUpperCase() + msg.provider.slice(1);
  const channelDisplay = stripAnsiAndControlChars(msg.channel_name || msg.channel_id || 'unknown');
  const senderDisplay = stripAnsiAndControlChars(msg.sender_name || msg.sender_id || 'unknown');
  const messageText = stripAnsiAndControlChars(msg.message_text || '(empty)');

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(msg.message_metadata || '{}');
  } catch {
    // Ignore parse errors
  }

  const isEdit = metadata.is_edit === true;
  const lines: string[] = [];
  lines.push(`\n[${isEdit ? 'EDITED' : 'INBOUND'} from ${provider} ${channelDisplay}]`);
  lines.push(`From: ${senderDisplay}`);
  lines.push(`Channel: ${channelDisplay}`);

  // Include thread info if available
  if (metadata.thread_ts) {
    lines.push(`Thread: ${stripAnsiAndControlChars(String(metadata.thread_ts))}`);
  }
  if (metadata.reply_to_message_id) {
    lines.push(`Reply to: ${stripAnsiAndControlChars(String(metadata.reply_to_message_id))}`);
  }

  lines.push(`Message: ${messageText}`);
  lines.push('---');

  // Suggest appropriate reply tool based on provider and message context
  const replyTool = getReplyToolName(msg.provider, metadata);
  if (replyTool) {
    lines.push(`Reply with ${replyTool} tool.`);
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Get the MCP tool name for replying to a message from this provider.
 *
 * Only returns tool names for providers that have registered MCP tools
 * in sandbox/internal/mcp/integration_tools.go. Returning a tool name
 * for a provider without registered tools would cause the agent to call
 * a non-existent tool, resulting in errors.
 *
 * Currently registered: Slack only. Discord/Telegram/etc. tools are planned
 * but not yet implemented — return null for them so the PTY hint doesn't
 * suggest an invalid tool.
 */
function getReplyToolName(provider: string, metadata: Record<string, unknown>): string | null {
  switch (provider) {
    case 'slack':
      // slack_reply_thread requires thread_ts; for top-level messages use slack_send_message
      return metadata.thread_ts ? 'slack_reply_thread' : 'slack_send_message';
    // Discord, Telegram, and other providers do not yet have MCP tools registered.
    // Uncomment these as tools are added to integration_tools.go:
    // case 'discord': return 'discord_send_message';
    // case 'telegram': return 'telegram_send_message';
    default: return null;
  }
}

/**
 * Clean up expired and old messages.
 * Called from the scheduled handler (minutely cron).
 */
export async function cleanupExpiredMessages(env: Env): Promise<void> {
  // Watchdog: reset stuck 'delivering' messages back to 'buffered' for retry.
  // If a worker crashes after claiming a message (status → delivering) but before
  // marking it delivered or resetting to buffered, the message would be stuck forever.
  // Uses claimed_at (set at claim time) rather than created_at to avoid resetting
  // old messages that were just freshly claimed after a long buffer period.
  const stuckReset = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'buffered', claimed_at = NULL
    WHERE status = 'delivering'
      AND claimed_at IS NOT NULL AND claimed_at < datetime('now', '-5 minutes')
      AND delivery_attempts < 3
  `).run();

  if (stuckReset.meta?.changes && stuckReset.meta.changes > 0) {
    console.log(`[delivery] Reset ${stuckReset.meta.changes} stuck delivering messages back to buffered`);
  }

  // Force-fail messages stuck in 'delivering' that have exhausted retries
  const stuckFailed = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'failed'
    WHERE status = 'delivering'
      AND claimed_at IS NOT NULL AND claimed_at < datetime('now', '-5 minutes')
      AND delivery_attempts >= 3
  `).run();

  if (stuckFailed.meta?.changes && stuckFailed.meta.changes > 0) {
    console.log(`[delivery] Failed ${stuckFailed.meta.changes} stuck delivering messages (max retries exceeded)`);
  }

  // Safety net: reset any 'delivering' messages without claimed_at (legacy or edge case)
  // that have been delivering for longer than 10 minutes based on created_at
  const legacyStuck = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = CASE WHEN delivery_attempts >= 3 THEN 'failed' ELSE 'buffered' END
    WHERE status = 'delivering'
      AND claimed_at IS NULL
      AND created_at < datetime('now', '-10 minutes')
  `).run();

  if (legacyStuck.meta?.changes && legacyStuck.meta.changes > 0) {
    console.log(`[delivery] Reset ${legacyStuck.meta.changes} legacy stuck delivering messages`);
  }

  // Expire buffered messages past their expires_at
  const expired = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'expired'
    WHERE status IN ('buffered', 'failed') AND expires_at < datetime('now')
  `).run();

  if (expired.meta?.changes && expired.meta.changes > 0) {
    console.log(`[delivery] Expired ${expired.meta.changes} old messages`);
  }

  // Delete delivered messages older than 7 days
  const cleaned = await env.DB.prepare(`
    DELETE FROM inbound_messages
    WHERE status = 'delivered' AND delivered_at < datetime('now', '-7 days')
  `).run();

  if (cleaned.meta?.changes && cleaned.meta.changes > 0) {
    console.log(`[delivery] Cleaned ${cleaned.meta.changes} old delivered messages`);
  }

  // Delete expired messages older than 7 days
  const cleanedExpired = await env.DB.prepare(`
    DELETE FROM inbound_messages
    WHERE status = 'expired' AND created_at < datetime('now', '-7 days')
  `).run();

  if (cleanedExpired.meta?.changes && cleanedExpired.meta.changes > 0) {
    console.log(`[delivery] Cleaned ${cleanedExpired.meta.changes} old expired messages`);
  }
}

/**
 * Retry delivery of failed/buffered messages for active sandboxes.
 * Called from the scheduled handler (minutely cron).
 *
 * Groups by (dashboard, messaging_item) to reuse the same fan-out logic
 * as the primary delivery path — each message goes to ALL connected terminals.
 */
export async function retryBufferedMessages(env: Env): Promise<void> {
  // Find (dashboard, messaging_item) pairs with buffered messages that have active sandboxes.
  // Also fetch sandbox session/machine info so we can create PTYs if needed.
  const targets = await env.DB.prepare(`
    SELECT DISTINCT im.dashboard_id, ms.item_id as messaging_item_id, ms.user_id, im.provider,
      ds.sandbox_session_id, ds.sandbox_machine_id
    FROM inbound_messages im
    JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
    JOIN dashboard_sandboxes ds ON ds.dashboard_id = im.dashboard_id
    WHERE im.status = 'buffered'
      AND ms.status = 'active'
      AND im.delivery_attempts < 3
      AND im.expires_at > datetime('now')
    LIMIT 10
  `).all<{
    dashboard_id: string; messaging_item_id: string; user_id: string; provider: string;
    sandbox_session_id: string; sandbox_machine_id: string;
  }>();

  if (!targets.results?.length) {
    return;
  }

  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  for (const row of targets.results) {
    try {
      // Find terminals connected to this messaging block that have an active integration + policy
      const connectedTerminals = await env.DB.prepare(`
        SELECT DISTINCT de.target_item_id
        FROM dashboard_edges de
        JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
        JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL AND ti.active_policy_id IS NOT NULL
        WHERE de.source_item_id = ?
      `).bind(row.provider, row.messaging_item_id).all<{ target_item_id: string }>();

      if (!connectedTerminals.results?.length) continue;

      // Resolve the effective user (dashboard owner) for PTY creation
      const owner = await env.DB.prepare(`
        SELECT user_id FROM dashboard_members
        WHERE dashboard_id = ? AND role = 'owner' LIMIT 1
      `).bind(row.dashboard_id).first<{ user_id: string }>();
      const effectiveUserId = owner?.user_id || row.user_id;

      // Resolve (or create) PTYs for each terminal. Unlike the old approach that only
      // looked for existing active PTYs (leaving messages stuck when no PTY was open),
      // this uses resolveTerminalPty which creates PTYs on demand.
      const terminalPtys: TerminalPty[] = [];
      for (const terminal of connectedTerminals.results) {
        try {
          const pty = await resolveTerminalPty(
            env, sandbox, row.dashboard_id, terminal.target_item_id,
            effectiveUserId, row.sandbox_session_id, row.sandbox_machine_id,
          );
          if (pty) terminalPtys.push(pty);
        } catch (err) {
          console.error(`[delivery] Retry: failed to resolve PTY for terminal ${terminal.target_item_id}:`, err);
        }
      }

      if (!terminalPtys.length) continue;

      await claimAndFanOut(env, sandbox, row.dashboard_id, row.messaging_item_id, row.provider, terminalPtys);
    } catch (err) {
      console.error(`[delivery] Retry failed for dashboard ${row.dashboard_id}:`, err);
    }
  }
}

/**
 * Wake sleeping VMs and drain stale buffered messages.
 * Called from the scheduled handler (minutely cron).
 *
 * retryBufferedMessages only targets dashboards with an active sandbox. This function
 * catches the gap: dashboards where messages are buffered but the VM is sleeping.
 * Without this, messages buffered while a VM is down (or policies added later) remain
 * undelivered until a new webhook triggers deliverOrWakeAndDrain or the user opens
 * the dashboard.
 *
 * Rate-limited to 2 dashboards per cycle to avoid thundering herd.
 */
export async function wakeAndDrainStaleMessages(env: Env): Promise<void> {
  // Find dashboards with stale buffered messages that do NOT have an active sandbox.
  // "Stale" = buffered for > 1 minute (gives the normal webhook→deliver path time to work).
  const targets = await env.DB.prepare(`
    SELECT DISTINCT im.dashboard_id, ms.item_id as messaging_item_id, ms.user_id, im.provider
    FROM inbound_messages im
    JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
    WHERE im.status = 'buffered'
      AND ms.status = 'active'
      AND im.delivery_attempts < 3
      AND im.expires_at > datetime('now')
      AND im.created_at < datetime('now', '-1 minutes')
      AND NOT EXISTS (
        SELECT 1 FROM dashboard_sandboxes ds WHERE ds.dashboard_id = im.dashboard_id
      )
    LIMIT 2
  `).all<{ dashboard_id: string; messaging_item_id: string; user_id: string; provider: string }>();

  if (!targets.results?.length) {
    return;
  }

  console.log(`[delivery] Waking ${targets.results.length} sleeping dashboard(s) to drain stale messages`);

  for (const row of targets.results) {
    try {
      await deliverOrWakeAndDrain(env, row.dashboard_id, row.messaging_item_id, row.user_id, row.provider);
    } catch (err) {
      console.error(`[delivery] Wake-and-drain failed for dashboard ${row.dashboard_id}:`, err);
    }
  }
}
