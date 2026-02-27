// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: messaging-delivery-v27-fix-retry-keepbuffered-condition
const MODULE_REVISION = 'messaging-delivery-v27-fix-retry-keepbuffered-condition';
console.log(`[messaging-delivery] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Message Delivery Module
 *
 * Delivers buffered inbound messages to sandbox PTYs, note blocks, and prompt blocks.
 * If the sandbox VM is sleeping, wakes it first using ensureDashbоardSandbоx().
 *
 * Flow:
 * 1. Check for connected targets (terminals, notes, prompts)
 * 2. For terminals: wake sandbox VM, find/create PTYs, write to PTYs
 * 3. For notes: append message text to item content, notify Durable Object
 * 4. For prompts: set item content to message text, notify Durable Object
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
import { formatItem } from '../dashboards/handler';

/** Messaging providers use edge-only authorization (no terminal_integrations / MCP tools). */
const MESSAGING_PROVIDERS = new Set(['whatsapp', 'slack', 'discord', 'teams', 'matrix', 'google_chat']);

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

interface ItemTarget {
  itemId: string;
  type: 'note' | 'prompt';
}

/**
 * Attempt to deliver buffered messages for a dashboard.
 * If the sandbox is not running, wakes it first.
 * Fans out to terminals connected to the messaging block that have an active
 * terminal_integration for the provider (policy gate — terminals without integration are skipped).
 * Also delivers to connected note blocks (append) and prompt blocks (set input).
 *
 * Called from webhook-handler.ts via ctx.waitUntil() after buffering a message.
 *
 * @param messagingItemId - The messaging block's item_id (used to resolve connected targets)
 * @param provider - The messaging provider (used to filter terminals by integration)
 */
export async function deliverOrWakeAndDrain(
  env: Env,
  dashboardId: string,
  messagingItemId: string,
  userId: string,
  provider: string,
): Promise<void> {
  // 1. Check for eligible targets BEFORE waking the sandbox.
  // Messaging providers: edge = authorization (no terminal_integrations needed).
  // Non-messaging providers: terminals must have an active terminal_integration with policy.
  // Notes/prompts only need an edge from the messaging block (edge = authorization).
  const [connectedTerminals, connectedItems] = await Promise.all([
    MESSAGING_PROVIDERS.has(provider)
      // Messaging: only deliver inbound messages to terminals with a messaging→terminal edge.
      // Terminal→messaging edges are for SENDING (outbound) only; they don't authorize receiving.
      ? env.DB.prepare(`
          SELECT DISTINCT de.target_item_id
          FROM dashboard_edges de
          JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
          WHERE de.source_item_id = ?
        `).bind(messagingItemId).all<{ target_item_id: string }>()
      : env.DB.prepare(`
          SELECT DISTINCT de.target_item_id
          FROM dashboard_edges de
          JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
          JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL AND ti.active_policy_id IS NOT NULL
          WHERE de.source_item_id = ?
        `).bind(provider, messagingItemId).all<{ target_item_id: string }>(),
    env.DB.prepare(`
      SELECT DISTINCT de.target_item_id, di.type
      FROM dashboard_edges de
      JOIN dashboard_items di ON di.id = de.target_item_id AND di.type IN ('note', 'prompt')
      WHERE de.source_item_id = ?
    `).bind(messagingItemId).all<{ target_item_id: string; type: string }>(),
  ]);

  const itemTargets: ItemTarget[] = (connectedItems.results || []).map(r => ({
    itemId: r.target_item_id,
    type: r.type as 'note' | 'prompt',
  }));

  if (!connectedTerminals.results?.length && !itemTargets.length) {
    // For messaging providers, no edges = message should not have been buffered.
    // Expire them to prevent stale delivery if an edge is drawn later.
    if (MESSAGING_PROVIDERS.has(provider)) {
      console.log(`[delivery] No inbound edges for messaging block ${messagingItemId} — expiring buffered messages`);
      await env.DB.prepare(`
        UPDATE inbound_messages SET status = 'expired'
        WHERE dashboard_id = ? AND status = 'buffered'
          AND subscription_id IN (
            SELECT id FROM messaging_subscriptions WHERE item_id = ?
          )
      `).bind(dashboardId, messagingItemId).run();
    } else {
      console.log(`[delivery] No targets connected to messaging block ${messagingItemId} — messages stay buffered`);
    }
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
      console.error(`[delivery] Dashboard ${dashboardId} has no owner — cannot deliver`);
      return;
    }
    effectiveUserId = owner.user_id;
  }

  // 3. Resolve terminal PTYs (only if terminals are connected)
  let terminalPtys: TerminalPty[] = [];
  let sandbox: SandboxClient | null = null;

  if (connectedTerminals.results?.length) {
    // Ensure sandbox is running (wakes VM if sleeping)
    const envWithCache = env as EnvWithDriveCache;
    const sandboxResult = await ensureDashbоardSandbоx(envWithCache, dashboardId, effectiveUserId);

    if (sandboxResult instanceof Response) {
      console.error(`[delivery] Failed to ensure sandbox for dashboard ${dashboardId}`);
      // Don't return — we can still deliver to note/prompt items
    } else {
      const { sandboxSessionId, sandboxMachineId } = sandboxResult;
      sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

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
    }
  }

  if (!terminalPtys.length && !itemTargets.length) {
    console.log(`[delivery] No active targets for dashboard ${dashboardId} — messages stay buffered`);
    return;
  }

  // 4. Claim and fan out buffered messages to all targets (terminals + items)
  const connectedTerminalEdgeCount = connectedTerminals.results?.length ?? 0;
  await claimAndFanOut(env, sandbox, dashboardId, messagingItemId, provider, terminalPtys, itemTargets, connectedTerminalEdgeCount);
}

/**
 * Deliver with fast in-process retries and backoff.
 *
 * Called from the webhook handler inside ctx.waitUntil(). After the initial attempt,
 * if messages are still buffered (e.g. sandbox starting up, transient PTY failure),
 * retries at 1s → 3s → 5s intervals before giving up and leaving to the minutely cron.
 *
 * The minutely cron (retryBufferedMessages + wakeAndDrainStaleMessages) is still a backstop
 * for cases where the Worker's waitUntil budget is exhausted before all retries complete.
 */
export async function deliverWithRetry(
  env: Env,
  dashboardId: string,
  messagingItemId: string,
  userId: string,
  provider: string,
  retryDelaysMs = [1000, 3000, 5000],
): Promise<void> {
  await deliverOrWakeAndDrain(env, dashboardId, messagingItemId, userId, provider);

  for (const delayMs of retryDelaysMs) {
    // Check if any messages are still buffered before sleeping
    const remaining = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM inbound_messages im
      JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
      WHERE im.dashboard_id = ? AND im.status = 'buffered'
        AND im.provider = ?
        AND ms.item_id = ? AND ms.status = 'active'
        AND im.expires_at > datetime('now')
    `).bind(dashboardId, provider, messagingItemId).first<{ count: number }>();

    if (!remaining?.count) break; // All delivered

    console.log(`[delivery] ${remaining.count} message(s) still buffered for dashboard ${dashboardId} — retrying in ${delayMs}ms`);
    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    await deliverOrWakeAndDrain(env, dashboardId, messagingItemId, userId, provider);
  }
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
 * Claim buffered messages and fan out to all connected targets (terminals + note/prompt items).
 *
 * Flow: claim each message (status → delivering), re-validate policy for terminals,
 * write to PTYs and/or update item content, then mark delivered.
 * The claim prevents concurrent workers from double-processing the same message,
 * while the fan-out ensures every connected target receives it.
 *
 * Per-target tracking: delivered_terminals (JSON array) tracks which targets
 * already received the message. On partial failure + retry, only the remaining
 * targets are attempted, preventing duplicate delivery.
 */
async function claimAndFanOut(
  env: Env,
  sandbox: SandboxClient | null,
  dashboardId: string,
  messagingItemId: string,
  provider: string,
  terminalPtys: TerminalPty[],
  itemTargets: ItemTarget[] = [],
  connectedTerminalEdgeCount = 0,
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

  const totalTargets = terminalPtys.length + itemTargets.length;
  console.log(`[delivery] Fanning out ${messages.results.length} messages to ${totalTargets} target(s) (${terminalPtys.length} terminal, ${itemTargets.length} item) for dashboard ${dashboardId}`);

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

      // Parse which targets already received this message (from previous partial delivery)
      let alreadyDelivered: Set<string>;
      try {
        alreadyDelivered = new Set(JSON.parse(msg.delivered_terminals || '[]') as string[]);
      } catch {
        alreadyDelivered = new Set();
      }

      const newlyDelivered: string[] = [];
      const failedTargets: string[] = [];

      // --- Deliver to note/prompt items (no policy gate — edge is the authorization) ---
      const remainingItems = itemTargets.filter(t => !alreadyDelivered.has(t.itemId));
      if (remainingItems.length) {
        for (const target of remainingItems) {
          try {
            await deliverToItem(env, dashboardId, target, msg);
            newlyDelivered.push(target.itemId);
          } catch (err) {
            console.error(`[delivery] Failed to deliver message ${msg.id} to ${target.type} ${target.itemId}:`, err);
            failedTargets.push(target.itemId);
          }
        }
      }

      // --- Deliver to terminal PTYs ---
      if (terminalPtys.length && sandbox) {
        let remainingPtys: TerminalPty[] = [];

        if (MESSAGING_PROVIDERS.has(provider)) {
          // Messaging providers: edge = authorization, no per-terminal policy check
          remainingPtys = terminalPtys.filter(p => !alreadyDelivered.has(p.terminalItemId));
        } else {
          // Non-messaging: re-validate against current per-terminal policies
          const allTerminalIds = terminalPtys.map(p => p.terminalItemId);
          const policyResult = await checkPerTerminalPolicy(env, msg, messagingItemId, allTerminalIds);

          if (policyResult === 'all_denied') {
            console.log(`[delivery] Message ${msg.id} denied by all terminal policies`);
          } else if (policyResult === 'no_policy') {
            console.log(`[delivery] Message ${msg.id} has no terminal policy configured`);
          } else {
            remainingPtys = terminalPtys.filter(p =>
              !alreadyDelivered.has(p.terminalItemId) && policyResult.get(p.terminalItemId) === true
            );
          }
        }

        if (remainingPtys.length) {
          const formattedMessage = formatMessageForPty(msg);
          const useExecute = MESSAGING_PROVIDERS.has(provider);
          for (const pty of remainingPtys) {
            try {
              await sandbox.writePty(pty.sessionId, pty.ptyId, formattedMessage, pty.machineId, undefined, useExecute);
              newlyDelivered.push(pty.terminalItemId);
            } catch (err) {
              console.error(`[delivery] Failed to write message ${msg.id} to terminal ${pty.terminalItemId}:`, err);
              failedTargets.push(pty.terminalItemId);
            }
          }
        }
      }

      // Check if all targets have been delivered (combining previous + new)
      const allDeliveredIds = [...alreadyDelivered, ...newlyDelivered];
      const allTargetsHandled = newlyDelivered.length > 0 || alreadyDelivered.size > 0;

      // If terminal edges exist but no PTYs were resolved (sandbox down or D1 lag),
      // keep buffered so the retry cron can attempt terminal delivery once the sandbox
      // recovers. This must NOT check newlyDeliveredToItems — on retry rounds the note
      // is already in alreadyDelivered so no new item delivery happens, but terminals
      // are still unresolved and must not be skipped.
      const keepBufferedForTerminalRetry = connectedTerminalEdgeCount > 0 && terminalPtys.length === 0;

      if (!failedTargets.length && allTargetsHandled && !keepBufferedForTerminalRetry) {
        await env.DB.prepare(`
          UPDATE inbound_messages
          SET status = 'delivered', delivered_at = datetime('now'), delivered_terminals = ?
          WHERE id = ?
        `).bind(JSON.stringify(allDeliveredIds), msg.id).run();
      } else if (keepBufferedForTerminalRetry) {
        // Terminal edges exist but no PTYs resolved — keep buffered for retry.
        // Respect the max-attempts limit so this doesn't retry forever.
        const newStatus = attemptsAfterClaim >= 3 ? 'failed' : 'buffered';
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = ?, delivered_terminals = ? WHERE id = ?
        `).bind(newStatus, JSON.stringify(allDeliveredIds), msg.id).run();
        if (newStatus === 'buffered') {
          console.log(`[delivery] Message ${msg.id}: ${connectedTerminalEdgeCount} terminal edge(s) unresolved — keeping buffered for terminal retry`);
        } else {
          console.log(`[delivery] Message ${msg.id}: terminal edges unresolved after max attempts — marking failed`);
        }
      } else if (failedTargets.length) {
        const newStatus = attemptsAfterClaim >= 3 ? 'failed' : 'buffered';
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = ?, delivered_terminals = ? WHERE id = ?
        `).bind(newStatus, JSON.stringify(allDeliveredIds), msg.id).run();

        if (newStatus === 'buffered') {
          console.log(`[delivery] Message ${msg.id}: ${newlyDelivered.length} delivered, ${failedTargets.length} failed — will retry`);
        }
      } else {
        // No targets were delivered and none failed — could be policy-denied terminals with no items
        // If there were item targets that all succeeded earlier, we'd have newlyDelivered > 0
        // This means all terminals were policy-denied and there are no item targets
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = 'failed' WHERE id = ?
        `).bind(msg.id).run();
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
 * Deliver a message to a note or prompt block by updating its content in D1
 * and notifying the Durable Object for real-time broadcast.
 *
 * - Notes: message text is appended to existing content (conversation log style)
 * - Prompts: message text replaces content (used as input for the next prompt execution)
 */
async function deliverToItem(
  env: Env,
  dashboardId: string,
  target: ItemTarget,
  msg: BufferedMessage,
): Promise<void> {
  const now = new Date().toISOString();
  const formattedText = formatMessageForItem(msg);

  if (target.type === 'note') {
    // Append to existing note content
    const existing = await env.DB.prepare(
      'SELECT content FROM dashboard_items WHERE id = ? AND dashboard_id = ?'
    ).bind(target.itemId, dashboardId).first<{ content: string }>();

    const currentContent = existing?.content || '';
    const separator = currentContent.trim() ? '\n' : '';
    const newContent = currentContent + separator + formattedText;

    await env.DB.prepare(
      'UPDATE dashboard_items SET content = ?, updated_at = ? WHERE id = ?'
    ).bind(newContent, now, target.itemId).run();
  } else {
    // Prompt: replace content with message text (raw, no formatting wrapper)
    await env.DB.prepare(
      'UPDATE dashboard_items SET content = ?, updated_at = ? WHERE id = ?'
    ).bind(msg.message_text || '', now, target.itemId).run();
  }

  // Notify Durable Object for real-time WebSocket broadcast
  const savedItem = await env.DB.prepare(
    'SELECT * FROM dashboard_items WHERE id = ?'
  ).bind(target.itemId).first();

  if (savedItem) {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    const formattedItem = formatItem(savedItem as Record<string, unknown>);
    await stub.fetch(new Request('http://do/item', {
      method: 'PUT',
      body: JSON.stringify(formattedItem),
    }));
  }

  console.log(`[delivery] Delivered message ${msg.id} to ${target.type} ${target.itemId}`);
}

/**
 * Format a message for display in a note block.
 * Simpler than the PTY format — no ANSI concerns, just readable text.
 */
function formatMessageForItem(msg: BufferedMessage): string {
  const provider = msg.provider.charAt(0).toUpperCase() + msg.provider.slice(1);
  const sender = msg.sender_name || msg.sender_id || 'unknown';
  const text = msg.message_text || '(empty)';
  const time = new Date(msg.created_at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `[${provider} · ${sender} · ${time}]\n${text}`;
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
  const messageText = stripAnsiAndControlChars(msg.message_text || '(empty)');

  // Messaging providers (WhatsApp, etc.) deliver plain text only — the edge defines
  // the relationship, and the agent sees the message as direct user input.
  // No wrapping newlines: writePty appends \r (Enter) to submit to the agent.
  if (MESSAGING_PROVIDERS.has(msg.provider)) {
    return messageText;
  }

  // Non-messaging providers (Slack, etc.) use the full structured format with metadata
  // so the agent knows the context and can reply via MCP tools.
  const provider = msg.provider.charAt(0).toUpperCase() + msg.provider.slice(1);
  const channelDisplay = stripAnsiAndControlChars(msg.channel_name || msg.channel_id || 'unknown');
  const senderDisplay = stripAnsiAndControlChars(msg.sender_name || msg.sender_id || 'unknown');

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
    case 'whatsapp':
      return null; // Messaging uses connection flow (edges), not MCP tools
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
 * as the primary delivery path — each message goes to ALL connected targets.
 */
export async function retryBufferedMessages(env: Env): Promise<void> {
  // Find (dashboard, messaging_item) pairs with buffered messages.
  // Include dashboards with active sandboxes (for terminal delivery) or any buffered messages
  // (for note/prompt delivery which doesn't need a sandbox).
  const targets = await env.DB.prepare(`
    SELECT DISTINCT im.dashboard_id, ms.item_id as messaging_item_id, ms.user_id, im.provider,
      ds.sandbox_session_id, ds.sandbox_machine_id
    FROM inbound_messages im
    JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
    LEFT JOIN dashboard_sandboxes ds ON ds.dashboard_id = im.dashboard_id
    WHERE im.status = 'buffered'
      AND ms.status = 'active'
      AND im.delivery_attempts < 3
      AND im.expires_at > datetime('now')
    LIMIT 10
  `).all<{
    dashboard_id: string; messaging_item_id: string; user_id: string; provider: string;
    sandbox_session_id: string | null; sandbox_machine_id: string | null;
  }>();

  if (!targets.results?.length) {
    return;
  }

  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  for (const row of targets.results) {
    try {
      // Find all connected targets: terminals and note/prompt items
      // Messaging providers use edge-only authorization; others require terminal_integrations
      const [connectedTerminals, connectedItems] = await Promise.all([
        MESSAGING_PROVIDERS.has(row.provider)
          // Messaging: only deliver to terminals with a messaging→terminal edge (inbound direction)
          ? env.DB.prepare(`
              SELECT DISTINCT de.target_item_id
              FROM dashboard_edges de
              JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
              WHERE de.source_item_id = ?
            `).bind(row.messaging_item_id).all<{ target_item_id: string }>()
          : env.DB.prepare(`
              SELECT DISTINCT de.target_item_id
              FROM dashboard_edges de
              JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
              JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL AND ti.active_policy_id IS NOT NULL
              WHERE de.source_item_id = ?
            `).bind(row.provider, row.messaging_item_id).all<{ target_item_id: string }>(),
        env.DB.prepare(`
          SELECT DISTINCT de.target_item_id, di.type
          FROM dashboard_edges de
          JOIN dashboard_items di ON di.id = de.target_item_id AND di.type IN ('note', 'prompt')
          WHERE de.source_item_id = ?
        `).bind(row.messaging_item_id).all<{ target_item_id: string; type: string }>(),
      ]);

      const itemTargets: ItemTarget[] = (connectedItems.results || []).map(r => ({
        itemId: r.target_item_id,
        type: r.type as 'note' | 'prompt',
      }));

      if (!connectedTerminals.results?.length && !itemTargets.length) continue;

      // Resolve terminal PTYs if sandbox is active and terminals are connected
      const terminalPtys: TerminalPty[] = [];
      if (connectedTerminals.results?.length && row.sandbox_session_id && row.sandbox_machine_id) {
        const owner = await env.DB.prepare(`
          SELECT user_id FROM dashboard_members
          WHERE dashboard_id = ? AND role = 'owner' LIMIT 1
        `).bind(row.dashboard_id).first<{ user_id: string }>();
        const effectiveUserId = owner?.user_id || row.user_id;

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
      }

      if (!terminalPtys.length && !itemTargets.length) continue;

      await claimAndFanOut(env, terminalPtys.length ? sandbox : null, row.dashboard_id, row.messaging_item_id, row.provider, terminalPtys, itemTargets, connectedTerminals.results?.length ?? 0);
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
