// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: sessions-v18-dashboard-eager-provision
const sessionsRevision = "sessions-v18-dashboard-eager-provision";
console.log(`[sessions] REVISION: ${sessionsRevision} loaded at ${new Date().toISOString()}`);

/**
 * Session Coordination Handlers
 *
 * Maps dashboard terminal items to sandbox sessions.
 * This is the bridge between the control plane and execution plane.
 */

import type { Session, DashboardItem } from '../types';
import { isDesktopFeatureDisabledError, type EnvWithDriveCache } from '../storage/drive-cache';
import { SandboxClient } from '../sandbox/client';
import { createDashboardToken } from '../auth/dashboard-token';
import { createPtyToken } from '../auth/pty-token';
import { sandboxFetch } from '../sandbox/fetch';
import { requireAuth, type AuthContext } from '../auth/middleware';
import { FlyMachinesClient, FlyMachineNotFoundError } from '../sandbox/fly-machines';
import { detectAgentType, logServerEvent } from '../analytics/handler';

// Whitelist of valid mirror table names (prevents SQL injection via table name interpolation)
// SECURITY: Never interpolate provider names directly into SQL - always use this map
const MIRROR_TABLES: Record<string, string> = {
  github: 'github_mirrors',
  box: 'box_mirrors',
  onedrive: 'onedrive_mirrors',
  drive: 'drive_mirrors',
};

function getMirrorTableName(provider: string): string | null {
  return MIRROR_TABLES[provider] ?? null;
}

function generateId(): string {
  return crypto.randomUUID();
}

// Map of Fly regions to their continent for geo-matching
const FLY_REGION_CONTINENTS: Record<string, string> = {
  // North America
  sjc: 'NA', lax: 'NA', sea: 'NA', ord: 'NA', iad: 'NA', atl: 'NA', dfw: 'NA', den: 'NA', yyz: 'NA', yul: 'NA', mia: 'NA',
  // Europe
  ams: 'EU', lhr: 'EU', cdg: 'EU', fra: 'EU', waw: 'EU', mad: 'EU', arn: 'EU', otp: 'EU',
  // South America
  gru: 'SA', scl: 'SA', bog: 'SA', eze: 'SA',
  // Asia Pacific
  nrt: 'AS', hkg: 'AS', sin: 'AS', bom: 'AS', maa: 'AS', syd: 'OC',
  // Africa
  jnb: 'AF',
};

/**
 * Pick the nearest configured Fly region based on CF continent code.
 * CF provides continent as: AF, AN, AS, EU, NA, OC, SA.
 * Returns the best match from the configured warm pool regions.
 */
export function nearestFlyRegion(cfContinent: string | undefined, warmPoolRegions: string[]): string | undefined {
  if (!cfContinent || warmPoolRegions.length === 0) return undefined;

  // Warn about unconfigured regions (geo-matching won't work for them)
  for (const r of warmPoolRegions) {
    if (!(r in FLY_REGION_CONTINENTS)) {
      console.warn(`[nearestFlyRegion] Region "${r}" not in FLY_REGION_CONTINENTS map — geo-matching disabled for this region`);
    }
  }

  // Prefer a region on the same continent
  const sameContinent = warmPoolRegions.filter(r => {
    const rc = FLY_REGION_CONTINENTS[r];
    return rc === cfContinent;
  });
  if (sameContinent.length > 0) return sameContinent[0];

  // Fallback affinity: EU/AF → EU regions, SA → NA regions, AS/OC → NA regions (until we add Asia)
  const affinityMap: Record<string, string[]> = {
    AF: ['EU', 'NA'],
    SA: ['NA', 'EU'],
    AS: ['OC', 'NA'],
    OC: ['AS', 'NA'],
    AN: ['SA', 'NA'],
  };
  const fallbacks = affinityMap[cfContinent] || [];
  for (const fallbackContinent of fallbacks) {
    const match = warmPoolRegions.find(r => FLY_REGION_CONTINENTS[r] === fallbackContinent);
    if (match) return match;
  }

  // Last resort: first configured region
  return warmPoolRegions[0];
}

interface TerminalContent {
  bootCommand?: string;
  ttsProvider?: string;
  ttsVoice?: string;
  workingDir?: string;
  skipApprovals?: boolean;
}

interface ParsedTerminalConfig {
  bootCommand: string;
  workingDir?: string;
}

// ElevenLabs voice name to ID mapping
// API requires voice IDs, but UI shows friendly names
const ELEVENLABS_VOICE_IDS: Record<string, string> = {
  'Rachel': '21m00Tcm4TlvDq8ikWAM',
  'Domi': 'AZnzlk1XvdvUeBnXmlld',
  'Bella': 'EXAVITQu4vr4xnSDxMaL',
  'Antoni': 'ErXwobaYiN019PkySvjV',
  'Elli': 'MF3mGyEYCl7XYWbV9V6O',
  'Josh': 'TxGEqnHWrfWFTfGW9XjX',
  'Arnold': 'VR6AewLTigWG4xSOukaG',
  'Adam': 'pNInz6obpgDQGcFmaJgB',
  'Sam': 'yoZ06aMxZJJ28mfd3POQ',
};

// Deepgram voice name to model mapping
// API requires full model names like "aura-asteria-en", UI shows friendly names
const DEEPGRAM_VOICE_MODELS: Record<string, string> = {
  'asteria': 'aura-asteria-en',
  'luna': 'aura-luna-en',
  'stella': 'aura-stella-en',
  'athena': 'aura-athena-en',
  'hera': 'aura-hera-en',
  'orion': 'aura-orion-en',
  'arcas': 'aura-arcas-en',
  'perseus': 'aura-perseus-en',
  'angus': 'aura-angus-en',
  'orpheus': 'aura-orpheus-en',
};

function parseTerminalConfig(content: unknown): ParsedTerminalConfig {
  if (typeof content !== 'string') {
    return { bootCommand: '' };
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return { bootCommand: '' };
  }
  try {
    const parsed = JSON.parse(trimmed) as TerminalContent;
    let bootCommand = typeof parsed.bootCommand === 'string' ? parsed.bootCommand : '';
    const workingDir = typeof parsed.workingDir === 'string' ? parsed.workingDir : undefined;

    // REVISION: sessions-v15-skip-approvals
    // Append per-agent CLI flag to skip approval prompts when enabled.
    // Must happen BEFORE TTS wrapping so the flag is part of the inner agent command.
    if (parsed.skipApprovals && bootCommand) {
      const cmd = bootCommand.trim().toLowerCase();
      if (cmd === 'claude' || cmd.startsWith('claude ')) {
        bootCommand += ' --dangerously-skip-permissions';
      } else if (cmd === 'codex' || cmd.startsWith('codex ')) {
        bootCommand += ' --dangerously-bypass-approvals-and-sandbox';
      } else if (cmd === 'gemini' || cmd.startsWith('gemini ')) {
        bootCommand += ' --approval-mode=yolo';
      }
    }

    // If TTS is enabled, wrap the command with talkito
    if (parsed.ttsProvider && parsed.ttsProvider !== 'none' && bootCommand) {
      const provider = parsed.ttsProvider;
      let voice = parsed.ttsVoice || '';

      // Map ElevenLabs voice names to IDs (API requires IDs, not names)
      if (provider === 'elevenlabs' && voice && ELEVENLABS_VOICE_IDS[voice]) {
        voice = ELEVENLABS_VOICE_IDS[voice];
      }

      // Map Deepgram voice names to full model names (API requires "aura-{name}-en" format)
      if (provider === 'deepgram' && voice && DEEPGRAM_VOICE_MODELS[voice]) {
        voice = DEEPGRAM_VOICE_MODELS[voice];
      }

      // talkito --disable-mcp --tts-provider {provider} --tts-voice {voice} --orcabot --asr-provider off {command}
      const talkitoArgs = [
        'talkito',
        '--disable-mcp',
        '--tts-provider', provider,
        ...(voice ? ['--tts-voice', voice] : []),
        '--orcabot',
        '--asr-provider', 'off',
        bootCommand,
      ];
      bootCommand = talkitoArgs.join(' ');
    }

    return { bootCommand, workingDir };
  } catch {
    return { bootCommand: '' };
  }
}

function fоrmatDashbоardItem(row: Record<string, unknown>): DashboardItem {
  return {
    id: row.id as string,
    dashboardId: row.dashboard_id as string,
    type: row.type as DashboardItem['type'],
    content: row.content as string,
    position: {
      x: row.position_x as number,
      y: row.position_y as number,
    },
    size: {
      width: row.width as number,
      height: row.height as number,
    },
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

async function getDashbоardSandbоx(env: EnvWithDriveCache, dashboardId: string) {
  return env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id, fly_volume_id, machine_state
    FROM dashboard_sandboxes WHERE dashboard_id = ?
  `).bind(dashboardId).first<{
    sandbox_session_id: string;
    sandbox_machine_id: string;
    fly_volume_id: string;
    machine_state: string;
  }>();
}

/**
 * Ensures a dashboard has exactly one sandbox VM.
 *
 * SECURITY CRITICAL: This function enforces the 1:1 dashboard-to-sandbox mapping.
 * Each dashboard MUST have its own dedicated VM because:
 * 1. The secrets broker runs per-sandbox and holds decrypted API keys
 * 2. Domain approvals are stored per-secret, not per-dashboard
 * 3. Output redaction uses session-local secret values
 *
 * If multiple dashboards ever shared a sandbox, secrets from one dashboard
 * would be accessible to agents/users in another dashboard. DO NOT modify
 * this to allow sandbox sharing between dashboards.
 */
export async function ensureDashbоardSandbоx(
  env: EnvWithDriveCache,
  dashboardId: string,
  userId: string,
  preferredRegion?: string
): Promise<{ sandboxSessionId: string; sandboxMachineId: string } | Response> {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79201: Not found or no access' }, { status: 404 });
  }

  // Feature flag: use per-dashboard Fly machine provisioning
  const flyProvisioningEnabled = env.FLY_PROVISIONING_ENABLED === 'true'
    && Boolean(env.FLY_API_TOKEN) && Boolean(env.FLY_APP_NAME);

  const existingSandbox = await getDashbоardSandbоx(env, dashboardId);

  // ── Handle existing sandbox ──────────────────────────────────────
  if (existingSandbox?.sandbox_session_id) {
    // If provisioning is enabled and we have a machine ID, check machine state
    if (flyProvisioningEnabled && existingSandbox.sandbox_machine_id) {
      const fly = new FlyMachinesClient(env.FLY_APP_NAME!, env.FLY_API_TOKEN!);
      try {
        const machine = await fly.getMachine(existingSandbox.sandbox_machine_id);
        if (machine.state === 'stopped' || machine.state === 'suspended') {
          // Wake the stopped machine
          console.log(`[ensureDashboardSandbox] Starting stopped machine ${existingSandbox.sandbox_machine_id} for dashboard ${dashboardId}`);
          await fly.startMachine(existingSandbox.sandbox_machine_id);
          await fly.waitForState(existingSandbox.sandbox_machine_id, 'started', 30);
          await env.DB.prepare(`
            UPDATE dashboard_sandboxes SET machine_state = 'started' WHERE dashboard_id = ?
          `).bind(dashboardId).run();
        }
      } catch (err) {
        if (err instanceof FlyMachineNotFoundError) {
          // Machine was destroyed externally — clear and reprovision below
          console.log(`[ensureDashboardSandbox] Machine ${existingSandbox.sandbox_machine_id} not found, clearing for reprovision`);
          await env.DB.prepare(`
            DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
          `).bind(dashboardId).run();
          // Fall through to provisioning below
          return ensureDashbоardSandbоxCreate(env, dashboardId, flyProvisioningEnabled, preferredRegion);
        }
        // For other Fly API errors, mark state as stale and fall through to session validation
        console.error(`[ensureDashboardSandbox] Fly API error checking machine: ${err}`);
        await env.DB.prepare(`
          UPDATE dashboard_sandboxes SET machine_state = 'unknown' WHERE dashboard_id = ?
        `).bind(dashboardId).run().catch(() => {});
      }
    }

    // Validate session still exists on sandbox (may be stale after redeploy).
    // Only a definitive 404 (session gone) triggers cleanup. Transient errors
    // (network flap, 502, timeout) return existing info — the caller's createPty
    // stale-session catch will handle true failures, and a retry will re-check.
    try {
      const checkRes = await sandboxFetch(
        env,
        `/sessions/${existingSandbox.sandbox_session_id}/ptys`,
        { machineId: existingSandbox.sandbox_machine_id || undefined }
      );

      if (checkRes.ok) {
        return {
          sandboxSessionId: existingSandbox.sandbox_session_id,
          sandboxMachineId: existingSandbox.sandbox_machine_id || '',
        };
      }

      if (checkRes.status === 404) {
        // Session definitively gone (sandbox process restarted, lost in-memory state)
        console.log(`[ensureDashboardSandbox] Session ${existingSandbox.sandbox_session_id} not found on sandbox (404), clearing for reprovision`);
        await env.DB.prepare(`
          DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
        `).bind(dashboardId).run();
        // Fall through to create new sandbox below
      } else {
        // Non-404 error (502, 503, etc.) — could be transient; return existing info
        // rather than destroying the sandbox record and forcing a full reprovision
        console.warn(`[ensureDashboardSandbox] Session validation returned ${checkRes.status}, returning existing sandbox (may be transient)`);
        return {
          sandboxSessionId: existingSandbox.sandbox_session_id,
          sandboxMachineId: existingSandbox.sandbox_machine_id || '',
        };
      }
    } catch (fetchErr) {
      // Timeout (AbortError) means the sandbox is completely unreachable — the Fly
      // machine is likely gone (destroyed, replaced by deployment, or Fly proxy PR04).
      // Waiting longer won't help. Delete the stale record and reprovision.
      const isTimeout = fetchErr instanceof Error &&
        (fetchErr.name === 'AbortError' || fetchErr.message.includes('The operation was aborted'));
      if (isTimeout) {
        console.warn(`[ensureDashboardSandbox] Session validation timed out — sandbox unreachable, clearing for reprovision`);
        await env.DB.prepare(`
          DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
        `).bind(dashboardId).run();
        // Fall through to create new sandbox below
      } else {
        // Non-timeout error (e.g. connection reset) — could be transient.
        // Return existing info; caller's createPty will retry or fail.
        console.warn(`[ensureDashboardSandbox] Session validation threw: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
        return {
          sandboxSessionId: existingSandbox.sandbox_session_id,
          sandboxMachineId: existingSandbox.sandbox_machine_id || '',
        };
      }
    }
  }

  // ── Create new sandbox ───────────────────────────────────────────
  return ensureDashbоardSandbоxCreate(env, dashboardId, flyProvisioningEnabled, preferredRegion);
}

/**
 * Internal: create a new sandbox for a dashboard.
 * When Fly provisioning is enabled, creates a dedicated machine + volume.
 * Otherwise, uses the shared SANDBOX_URL (legacy behavior).
 */
async function ensureDashbоardSandbоxCreate(
  env: EnvWithDriveCache,
  dashboardId: string,
  flyProvisioningEnabled: boolean,
  preferredRegion?: string,
  egressEnabled?: boolean
): Promise<{ sandboxSessionId: string; sandboxMachineId: string }> {
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const now = new Date().toISOString();
  const mcpToken = await createDashboardToken(dashboardId, env.INTERNAL_API_TOKEN);

  if (flyProvisioningEnabled) {
    return provisionDedicatedMachine(env, dashboardId, sandbox, mcpToken, now, preferredRegion, egressEnabled);
  }

  // ── Legacy path: shared SANDBOX_URL ──────────────────────────────
  const sandboxSession = await sandbox.createSessiоn(dashboardId, mcpToken, undefined, egressEnabled);
  const insertResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(dashboardId, sandboxSession.id, sandboxSession.machineId || '', now).run();

  if (insertResult.meta.changes === 0) {
    const reused = await getDashbоardSandbоx(env, dashboardId);
    if (reused?.sandbox_session_id) {
      if (reused.sandbox_session_id !== sandboxSession.id) {
        await sandbox.deleteSession(sandboxSession.id, sandboxSession.machineId);
      }
      return {
        sandboxSessionId: reused.sandbox_session_id,
        sandboxMachineId: reused.sandbox_machine_id || '',
      };
    }
  }

  return {
    sandboxSessionId: sandboxSession.id,
    sandboxMachineId: sandboxSession.machineId || '',
  };
}

/**
 * Eagerly claim a warm VM at dashboard creation time.
 *
 * By claiming at dashboard creation rather than first terminal open, we eliminate
 * the race condition window where multiple terminals opening simultaneously each
 * attempt to provision their own VM. Once this completes, all terminals on the
 * dashboard find an existing sandbox and skip provisioning entirely.
 *
 * Warm-only: cold provisioning (90s) would block or create background work that
 * outlives the dashboard creation request. If no warm machine is available, the
 * first terminal will cold-provision as before.
 */
export async function preProvisionDashboardSandbox(
  env: EnvWithDriveCache,
  dashboardId: string,
  preferredRegion?: string,
): Promise<void> {
  const flyProvisioningEnabled = env.FLY_PROVISIONING_ENABLED === 'true'
    && Boolean(env.FLY_API_TOKEN) && Boolean(env.FLY_APP_NAME);
  if (!flyProvisioningEnabled) return;

  // Skip if sandbox already exists (e.g. reprovision after template copy)
  const existing = await getDashbоardSandbоx(env, dashboardId);
  if (existing?.sandbox_session_id) return;

  const fly = new FlyMachinesClient(env.FLY_APP_NAME!, env.FLY_API_TOKEN!);
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const now = new Date().toISOString();
  const mcpToken = await createDashboardToken(dashboardId, env.INTERNAL_API_TOKEN);

  const result = await claimWarmMachine(
    env, fly, dashboardId, sandbox, mcpToken, now, preferredRegion, false,
  );
  if (result) {
    console.log(`[preProvision] Eagerly claimed VM for dashboard ${dashboardId}: machine=${result.sandboxMachineId}`);
  } else {
    console.log(`[preProvision] No warm machine available for ${dashboardId} — first terminal will provision`);
  }
}

/**
 * Provision a dedicated Fly machine + volume for a dashboard.
 *
 * Flow:
 * 1. Create a Fly volume for /workspace
 * 2. Create a Fly machine with the volume mounted
 * 3. Wait for the machine to start
 * 4. Create a sandbox session on the new machine (pinned via X-Sandbox-Machine-ID)
 * 5. Store in dashboard_sandboxes
 *
 * On race condition (two terminals starting simultaneously):
 * - The INSERT OR IGNORE with PRIMARY KEY on dashboard_id ensures only one wins
 * - The loser cleans up its resources and uses the winner's row
 */
async function provisionDedicatedMachine(
  env: EnvWithDriveCache,
  dashboardId: string,
  sandbox: SandboxClient,
  mcpToken: string,
  now: string,
  preferredRegion?: string,
  egressEnabled?: boolean
): Promise<{ sandboxSessionId: string; sandboxMachineId: string }> {
  const fly = new FlyMachinesClient(env.FLY_APP_NAME!, env.FLY_API_TOKEN!);

  // Try warm pool first (instant provisioning)
  const warmResult = await claimWarmMachine(env, fly, dashboardId, sandbox, mcpToken, now, preferredRegion, egressEnabled);
  if (warmResult) return warmResult;

  // Fall back to cold provisioning
  return coldProvisionMachine(env, fly, dashboardId, sandbox, mcpToken, now, preferredRegion, egressEnabled);
}

/**
 * Try to claim a pre-provisioned warm machine for instant dashboard assignment.
 */
async function claimWarmMachine(
  env: EnvWithDriveCache,
  fly: FlyMachinesClient,
  dashboardId: string,
  sandbox: SandboxClient,
  mcpToken: string,
  now: string,
  preferredRegion?: string,
  egressEnabled?: boolean
): Promise<{ sandboxSessionId: string; sandboxMachineId: string } | null> {
  // Claim a warm machine: prefer one in the user's region, fall back to any available
  let warm: { machine_id: string; volume_id: string } | null = null;

  if (preferredRegion) {
    warm = await env.DB.prepare(`
      SELECT machine_id, volume_id FROM warm_machines WHERE region = ? LIMIT 1
    `).bind(preferredRegion).first<{ machine_id: string; volume_id: string }>();
  }

  // Fall back to any region (any warm machine beats cold provisioning)
  if (!warm) {
    warm = await env.DB.prepare(`
      SELECT machine_id, volume_id FROM warm_machines LIMIT 1
    `).first<{ machine_id: string; volume_id: string }>();
  }

  if (!warm) return null;

  const { machine_id: machineId, volume_id: volumeId } = warm;
  const deleted = await env.DB.prepare(`
    DELETE FROM warm_machines WHERE machine_id = ?
  `).bind(machineId).run();

  // Another request claimed it first — no warm machine for us
  if (deleted.meta.changes === 0) return null;

  try {
    // Start the machine if it's stopped (warm machines auto-stop when idle)
    const machine = await fly.getMachine(machineId);
    if (machine.state === 'stopped') {
      await fly.startMachine(machineId);
      await fly.waitForState(machineId, 'started', 30);
    } else if (machine.state !== 'started') {
      console.log(`[claimWarmMachine] Warm machine ${machineId} in unexpected state: ${machine.state}, falling back to cold`);
      // Clean up the bad warm machine
      await cleanupFlyResources(fly, machineId, volumeId);
      return null;
    }

    // Disable autostop so Fly doesn't hibernate this active dashboard machine.
    // Warm pool machines have autostop:'stop' for hibernation; once claimed, disable it.
    await fly.disableAutostop(machineId); // best-effort, non-throwing

    // Create sandbox session pinned to this machine
    const sandboxSession = await sandbox.createSessiоn(dashboardId, mcpToken, machineId, egressEnabled);

    // Clean up lost+found (ext4 creates this on new volumes)
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.set('Authorization', `Bearer ${env.SANDBOX_INTERNAL_TOKEN}`);
      headers.set('X-Sandbox-Machine-ID', machineId);
      await fetch(`${env.SANDBOX_URL}/sessions/${sandboxSession.id}/file?path=/workspace/lost%2Bfound`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      // Best-effort cleanup
    }

    // Store in DB
    const insertResult = await env.DB.prepare(`
      INSERT OR IGNORE INTO dashboard_sandboxes
        (dashboard_id, sandbox_session_id, sandbox_machine_id, fly_volume_id, machine_state, created_at)
      VALUES (?, ?, ?, ?, 'started', ?)
    `).bind(dashboardId, sandboxSession.id, machineId, volumeId, now).run();

    if (insertResult.meta.changes === 0) {
      const winner = await getDashbоardSandbоx(env, dashboardId);
      await cleanupFlyResources(fly, machineId, volumeId, sandbox, sandboxSession.id);
      if (winner?.sandbox_session_id) {
        return {
          sandboxSessionId: winner.sandbox_session_id,
          sandboxMachineId: winner.sandbox_machine_id || '',
        };
      }
    }

    return {
      sandboxSessionId: sandboxSession.id,
      sandboxMachineId: machineId,
    };
  } catch (err) {
    console.error(`[claimWarmMachine] Failed to use warm machine ${machineId}: ${err}`);
    // Destroy the broken warm machine, fall back to cold provisioning
    await cleanupFlyResources(fly, machineId, volumeId);
    return null;
  }
}

/**
 * Cold-provision a new Fly machine with volume from scratch.
 */
async function coldProvisionMachine(
  env: EnvWithDriveCache,
  fly: FlyMachinesClient,
  dashboardId: string,
  sandbox: SandboxClient,
  mcpToken: string,
  now: string,
  preferredRegion?: string,
  egressEnabled?: boolean
): Promise<{ sandboxSessionId: string; sandboxMachineId: string }> {
  const region = preferredRegion || env.FLY_REGION || 'sjc';

  // Auto-discover image from existing machines (Fly uses deployment-specific tags, not :latest)
  let image = env.FLY_MACHINE_IMAGE || '';
  if (!image || image.endsWith(':latest')) {
    const discovered = await fly.discoverImage();
    if (discovered) {
      image = discovered;
    } else if (!image) {
      throw new Error('No FLY_MACHINE_IMAGE configured and no existing machines to discover image from');
    }
  }

  let volumeId = '';
  let machineId = '';

  try {
    // Step 1: Create volume
    const volumeSuffix = crypto.randomUUID().slice(0, 6);
    const volumeName = `orcabot_ws_${dashboardId.slice(0, 8).replace(/-/g, '')}_${volumeSuffix}`;
    const volume = await fly.createVolume(volumeName, region, 10);
    volumeId = volume.id;

    // Step 2: Create machine with volume
    const sbToken = env.SANDBOX_INTERNAL_TOKEN;
    const intToken = env.INTERNAL_API_TOKEN;
    console.log(`[coldProvisionMachine] token check: SANDBOX_INTERNAL_TOKEN=${sbToken ? `set(len=${sbToken.length},prefix=${sbToken.slice(0,4)})` : 'MISSING'} INTERNAL_API_TOKEN=${intToken ? `set(len=${intToken.length},prefix=${intToken.slice(0,4)})` : 'MISSING'}`);
    const machineConfig = FlyMachinesClient.buildMachineConfig({
      dashboardId,
      volumeId,
      image,
      region,
      env: {
        SANDBOX_INTERNAL_TOKEN: env.SANDBOX_INTERNAL_TOKEN,
        CONTROLPLANE_URL: env.FLY_SANDBOX_CONTROLPLANE_URL || 'https://api.orcabot.com',
        INTERNAL_API_TOKEN: env.INTERNAL_API_TOKEN,
        DASHBOARD_ID: dashboardId,
        ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || 'https://orcabot.com',
      },
    });

    const machine = await fly.createMachine(machineConfig);
    machineId = machine.id;

    // Step 3: Wait for machine to be ready
    await fly.waitForState(machineId, 'started', 90);

    // Disable autostop so Fly doesn't hibernate this active dashboard machine
    await fly.disableAutostop(machineId); // best-effort, non-throwing

    // Step 4: Create sandbox session pinned to the new machine
    const sandboxSession = await sandbox.createSessiоn(dashboardId, mcpToken, machineId, egressEnabled);

    // Step 4b: Clean up lost+found (ext4 creates this on new volumes)
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.set('Authorization', `Bearer ${env.SANDBOX_INTERNAL_TOKEN}`);
      headers.set('X-Sandbox-Machine-ID', machineId);
      await fetch(`${env.SANDBOX_URL}/sessions/${sandboxSession.id}/file?path=/workspace/lost%2Bfound`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      // Best-effort cleanup
    }

    // Step 5: Store in DB (FK can fail if dashboard was deleted during provisioning)
    let insertResult;
    try {
      insertResult = await env.DB.prepare(`
        INSERT OR IGNORE INTO dashboard_sandboxes
          (dashboard_id, sandbox_session_id, sandbox_machine_id, fly_volume_id, machine_state, created_at)
        VALUES (?, ?, ?, ?, 'started', ?)
      `).bind(dashboardId, sandboxSession.id, machineId, volumeId, now).run();
    } catch (dbErr) {
      // FK constraint = dashboard was deleted during provisioning; clean up
      console.error(`[coldProvisionMachine] Dashboard ${dashboardId} no longer exists, cleaning up machine ${machineId}`);
      await cleanupFlyResources(fly, machineId, volumeId, sandbox, sandboxSession.id);
      throw new Error('Dashboard was deleted during provisioning');
    }

    // Handle race condition: another request won the insert
    if (insertResult.meta.changes === 0) {
      const winner = await getDashbоardSandbоx(env, dashboardId);
      await cleanupFlyResources(fly, machineId, volumeId, sandbox, sandboxSession.id);
      if (winner?.sandbox_session_id) {
        return {
          sandboxSessionId: winner.sandbox_session_id,
          sandboxMachineId: winner.sandbox_machine_id || '',
        };
      }
    }

    return {
      sandboxSessionId: sandboxSession.id,
      sandboxMachineId: machineId,
    };
  } catch (err) {
    const bodyDetail = (err as any)?.responseBody ? ` | body: ${(err as any).responseBody}` : '';
    console.error(`[coldProvisionMachine] Failed for dashboard ${dashboardId}: ${err}${bodyDetail}`);
    await cleanupFlyResources(fly, machineId, volumeId);
    throw err;
  }
}

/**
 * Best-effort cleanup of Fly resources on failure or race condition.
 */
async function cleanupFlyResources(
  fly: FlyMachinesClient,
  machineId: string,
  volumeId: string,
  sandbox?: SandboxClient,
  sessionId?: string
): Promise<void> {
  if (sessionId && sandbox) {
    try { await sandbox.deleteSession(sessionId, machineId); } catch (e) {
      console.error(`[cleanupFlyResources] Failed to delete session ${sessionId}: ${e}`);
    }
  }
  if (machineId) {
    try { await fly.destroyMachine(machineId, true); } catch (e) {
      console.error(`[cleanupFlyResources] Failed to destroy machine ${machineId}: ${e}`);
    }
  }
  if (volumeId) {
    try { await fly.deleteVolume(volumeId); } catch (e) {
      console.error(`[cleanupFlyResources] Failed to delete volume ${volumeId}: ${e}`);
    }
  }
}

function driveManifestKey(dashboardId: string): string {
  return `drive/${dashboardId}/manifest.json`;
}

function mirrorManifestKey(provider: string, dashboardId: string): string {
  return `mirror/${provider}/${dashboardId}/manifest.json`;
}

function workspaceSnapshotKey(dashboardId: string): string {
  return `workspace/${dashboardId}/snapshot.json`;
}

export async function clearWorkspaceDev(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  if (env.DEV_AUTH_ENABLED !== 'true') {
    return Response.json({ error: 'E79790: Dev mode only' }, { status: 403 });
  }

  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };
  if (!data.dashboardId) {
    return Response.json({ error: 'E79791: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79792: Not found or no access' }, { status: 404 });
  }

  await env.DRIVE_CACHE.delete(workspaceSnapshotKey(data.dashboardId));
  await env.DRIVE_CACHE.delete(driveManifestKey(data.dashboardId));
  for (const provider of ['github', 'box', 'onedrive']) {
    await env.DRIVE_CACHE.delete(mirrorManifestKey(provider, data.dashboardId));
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'idle',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        last_sync_at = null,
        updated_at = ?
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();

  await env.DB.prepare(`
    UPDATE github_mirrors
    SET status = 'idle',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        cache_last_path = null,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        last_sync_at = null,
        updated_at = ?
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();

  await env.DB.prepare(`
    UPDATE box_mirrors
    SET status = 'idle',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        last_sync_at = null,
        updated_at = ?
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();

  await env.DB.prepare(`
    UPDATE onedrive_mirrors
    SET status = 'idle',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        last_sync_at = null,
        updated_at = ?
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();

  let deletedFiles = 0;
  let deletedDirs = 0;
  let remainingFiles = 0;
  let remainingDirs = 0;
  let hasMore = false;

  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id
    FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(data.dashboardId).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();

  if (sandboxRecord?.sandbox_session_id) {
    try {
      const res = await sandboxFetch(
        env,
        `/sessions/${sandboxRecord.sandbox_session_id}/files?path=/&recursive=true`,
        { machineId: sandboxRecord.sandbox_machine_id || undefined, timeoutMs: 15_000 }
      );
      if (res.ok) {
        const payload = await res.json() as { files?: Array<{ path?: string; is_dir?: boolean }> };
        const entries = (payload.files || []);
        const files = entries
          .filter((entry) => entry && !entry.is_dir && typeof entry.path === 'string')
          .map((entry) => entry.path as string);
        const dirs = entries
          .filter((entry) => entry && entry.is_dir && typeof entry.path === 'string')
          .map((entry) => entry.path as string)
          .sort((a, b) => b.length - a.length);
        const MAX_DELETE = 40;
        const batch = files.slice(0, MAX_DELETE);
        for (const path of batch) {
          try {
            await sandboxFetch(
              env,
              `/sessions/${sandboxRecord.sandbox_session_id}/file?path=${encodeURIComponent(path)}`,
              { method: 'DELETE', machineId: sandboxRecord.sandbox_machine_id || undefined }
            );
            deletedFiles += 1;
          } catch (error) {
            console.error('[clearWorkspaceDev] Failed to delete file', path, error);
          }
        }
        remainingFiles = Math.max(0, files.length - batch.length);

        if (remainingFiles === 0 && dirs.length > 0) {
          const dirBatch = dirs.slice(0, MAX_DELETE);
          for (const path of dirBatch) {
            try {
              await sandboxFetch(
                env,
                `/sessions/${sandboxRecord.sandbox_session_id}/file?path=${encodeURIComponent(path)}`,
                { method: 'DELETE', machineId: sandboxRecord.sandbox_machine_id || undefined }
              );
              deletedDirs += 1;
            } catch (error) {
              console.error('[clearWorkspaceDev] Failed to delete dir', path, error);
            }
          }
          remainingDirs = Math.max(0, dirs.length - dirBatch.length);
        } else {
          remainingDirs = dirs.length;
        }

        // Only claim hasMore if we actually made progress this batch.
        // Otherwise the frontend loop spins endlessly on undeletable files.
        const madeProgress = deletedFiles > 0 || deletedDirs > 0;
        hasMore = madeProgress && (remainingFiles > 0 || remainingDirs > 0);
      }
    } catch (error) {
      console.error('[clearWorkspaceDev] Failed to list workspace files', error);
    }
  }

  return Response.json({ ok: true, deletedFiles, deletedDirs, remainingFiles, remainingDirs, hasMore });
}

/**
 * Capture a recursive file listing from the sandbox and store in R2.
 * Best-effort — failures are silently ignored since the sandbox may be shutting down.
 */
async function captureWorkspaceSnapshot(
  env: EnvWithDriveCache,
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string
): Promise<void> {
  try {
    const res = await sandboxFetch(
      env,
      `/sessions/${sandboxSessionId}/files?path=/&recursive=true`,
      { machineId: sandboxMachineId || undefined, timeoutMs: 15_000 }
    );
    if (!res.ok) return;

    const data = await res.json() as { files?: unknown[] };
    if (!data.files || data.files.length === 0) return;

    const snapshot = {
      version: 1,
      dashboardId,
      capturedAt: new Date().toISOString(),
      fileCount: data.files.length,
      files: data.files,
    };

    await env.DRIVE_CACHE.put(
      workspaceSnapshotKey(dashboardId),
      JSON.stringify(snapshot),
      { httpMetadata: { contentType: 'application/json' } }
    );
  } catch {
    // Best-effort — sandbox may be shutting down
  }
}

async function triggerDriveMirrorSync(
  env: EnvWithDriveCache,
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string
) {
  const mirror = await env.DB.prepare(`
    SELECT folder_name FROM drive_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ folder_name: string }>();

  if (!mirror) {
    return;
  }

  const manifest = await env.DRIVE_CACHE.head(driveManifestKey(dashboardId));
  if (!manifest) {
    return;
  }

  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_workspace', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();

  await sandboxFetch(env, `/sessions/${sandboxSessionId}/drive/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dashboard_id: dashboardId,
      folder_name: mirror.folder_name,
    }),
    machineId: sandboxMachineId || undefined,
  });
}

async function triggerMirrorSync(
  env: EnvWithDriveCache,
  provider: 'github' | 'box' | 'onedrive',
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string,
  folderName: string
) {
  const manifest = await env.DRIVE_CACHE.head(mirrorManifestKey(provider, dashboardId));
  if (!manifest) {
    return;
  }

  // SECURITY: Use whitelist to get table name - never interpolate provider directly
  const tableName = getMirrorTableName(provider);
  if (!tableName) {
    console.error(`[sessions] Invalid mirror provider: ${provider}`);
    return;
  }

  await env.DB.prepare(`
    UPDATE ${tableName}
    SET status = 'syncing_workspace', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();

  await sandboxFetch(env, `/sessions/${sandboxSessionId}/mirror/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider,
      dashboard_id: dashboardId,
      folder_name: folderName,
    }),
    machineId: sandboxMachineId || undefined,
  });
}

// Create a session for a terminal item
export async function createSessiоn(
  env: EnvWithDriveCache,
  dashboardId: string,
  itemId: string,
  userId: string,
  userName: string,
  preferredRegion?: string,
  egressEnabled?: boolean,
  ctx?: Pick<ExecutionContext, 'waitUntil'>
): Promise<Response> {
  // Check access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79201: Not found or no access' }, { status: 404 });
  }

  // Check if item exists and is a terminal
  const item = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ? AND dashboard_id = ? AND type = 'terminal'
  `).bind(itemId, dashboardId).first();

  if (!item) {
    return Response.json({ error: 'E79202: Terminal item not found' }, { status: 404 });
  }

  // Check if session already exists for this item
  const existingSession = await env.DB.prepare(`
    SELECT * FROM sessions WHERE item_id = ? AND status IN ('creating', 'active')
  `).bind(itemId).first();

  if (existingSession) {
    return Response.json({
      session: {
        id: existingSession.id,
        dashboardId: existingSession.dashboard_id,
        itemId: existingSession.item_id,
        ownerUserId: existingSession.owner_user_id,
        ownerName: existingSession.owner_name,
        sandboxSessionId: existingSession.sandbox_session_id,
        sandboxMachineId: existingSession.sandbox_machine_id,
        ptyId: existingSession.pty_id,
        status: existingSession.status,
        region: existingSession.region,
        createdAt: existingSession.created_at,
        stoppedAt: existingSession.stopped_at,
      }
    });
  }

  const id = generateId();
  const now = new Date().toISOString();

  // Detect agent type from raw boot command (before talkito wrapping)
  let rawBootCommand = '';
  try {
    if (typeof item.content === 'string' && item.content.trim().startsWith('{')) {
      const parsed = JSON.parse(item.content.trim()) as { bootCommand?: string };
      rawBootCommand = typeof parsed.bootCommand === 'string' ? parsed.bootCommand : '';
    }
  } catch { /* ignore parse errors */ }
  const agentType = detectAgentType(rawBootCommand);

  // Create session record first.
  // Try with agent_type column; fall back to without if the column doesn't exist yet
  // (migration may not have run if worker deployed before /init-db).
  try {
    await env.DB.prepare(`
      INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, region, agent_type, created_at)
      VALUES (?, ?, ?, ?, ?, '', '', '', 'creating', 'local', ?, ?)
    `).bind(id, dashboardId, itemId, userId, userName, agentType, now).run();
  } catch {
    // agent_type column likely doesn't exist yet — insert without it
    await env.DB.prepare(`
      INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, region, created_at)
      VALUES (?, ?, ?, ?, ?, '', '', '', 'creating', 'local', ?)
    `).bind(id, dashboardId, itemId, userId, userName, now).run();
  }

  // Create sandbox session and PTY
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  try {
    const terminalConfig = parseTerminalConfig(item.content);
    const { bootCommand, workingDir } = terminalConfig;

    // Use ensureDashboardSandbox which checks machine health via Fly API,
    // handles destroyed machines (FlyMachineNotFoundError → reprovision),
    // and validates the session is still reachable on the sandbox.
    const sandboxResult = await ensureDashbоardSandbоx(env, dashboardId, userId, preferredRegion);
    if (sandboxResult instanceof Response) {
      // Access denied or other error — clean up the creating session record
      await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
      return sandboxResult;
    }
    let { sandboxSessionId, sandboxMachineId } = sandboxResult;

    // Create PTY within the dashboard sandbox, assigning control to the creator
    // If the session is stale (sandbox redeployed), clear it and create a fresh one
    // Generate PTY ID and integration token on control plane for secure gateway authentication
    const ptyId = generateId();
    const integrationToken = await createPtyToken(
      ptyId,
      sandboxSessionId,
      dashboardId,
      userId,
      env.INTERNAL_API_TOKEN
    );

    let pty: { id: string };
    try {
      // Inner try: handle working directory not found (E79708) — fall back to workspace root.
      // This happens when reopening an old dashboard whose GitHub mirror / workspace is gone.
      try {
        pty = await sandbox.createPty(sandboxSessionId, userId, bootCommand, sandboxMachineId, {
          ptyId,
          integrationToken,
          workingDir,
          egressEnabled,
        });
      } catch (wdErr) {
        if (workingDir && wdErr instanceof Error && wdErr.message.includes('E79708')) {
          console.log(`[createSession] Working dir "${workingDir}" not found, falling back to workspace root`);
          pty = await sandbox.createPty(sandboxSessionId, userId, bootCommand, sandboxMachineId, {
            ptyId,
            integrationToken,
            egressEnabled,
          });
        } else {
          throw wdErr;
        }
      }
    } catch (err) {
      // Treat definitively gone (404) or completely unreachable (timeout/abort) as stale.
      // If the sandbox timed out, the Fly machine is effectively gone — retrying the same
      // machine won't help. Reprovision to get a working sandbox.
      // Other errors (502, 409 Fly-Replay) may be transient — let them propagate.
      const isStaleSession = err instanceof Error && err.message.includes('404');
      const isUnreachable = err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('The operation was aborted'));
      if (!isStaleSession && !isUnreachable) {
        throw err;
      }

      // Stale/unreachable session — clear it and create a fresh sandbox
      console.log(`[createSession] Sandbox ${isUnreachable ? 'unreachable (timeout)' : 'stale (404)'} for session ${sandboxSessionId}, reprovisioning`);
      await env.DB.prepare(`
        DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
      `).bind(dashboardId).run();

      // Create fresh sandbox session (uses Fly provisioning if enabled)
      const flyProvisioningEnabled = env.FLY_PROVISIONING_ENABLED === 'true'
        && Boolean(env.FLY_API_TOKEN) && Boolean(env.FLY_APP_NAME);
      const freshResult = await ensureDashbоardSandbоxCreate(env, dashboardId, flyProvisioningEnabled, preferredRegion, egressEnabled);
      sandboxSessionId = freshResult.sandboxSessionId;
      sandboxMachineId = freshResult.sandboxMachineId;

      // Regenerate integration token with fresh sandbox session ID
      const freshIntegrationToken = await createPtyToken(
        ptyId,
        sandboxSessionId,
        dashboardId,
        userId,
        env.INTERNAL_API_TOKEN
      );

      // Retry PTY creation on fresh session — omit workingDir (fresh sandbox has empty workspace)
      pty = await sandbox.createPty(sandboxSessionId, userId, bootCommand, sandboxMachineId, {
        ptyId,
        integrationToken: freshIntegrationToken,
        egressEnabled,
      });
    }

    // Update with sandbox session ID and PTY ID
    await env.DB.prepare(`
      UPDATE sessions SET sandbox_session_id = ?, sandbox_machine_id = ?, pty_id = ?, status = 'active' WHERE id = ?
    `).bind(sandboxSessionId, sandboxMachineId, pty.id, id).run();

    // Migrate terminal integrations from previous session(s) to the new PTY ID.
    // Integrations are keyed by terminal_id (PTY ID) which changes each session,
    // but item_id (dashboard item ID) is stable. This ensures integrations + policies
    // persist across session boundaries for the same terminal block.
    try {
      const migrated = await env.DB.prepare(`
        UPDATE terminal_integrations
        SET terminal_id = ?, updated_at = datetime('now')
        WHERE item_id = ? AND dashboard_id = ? AND deleted_at IS NULL
          AND terminal_id != ?
      `).bind(pty.id, itemId, dashboardId, pty.id).run();

      // migrated.meta.changes integration(s) updated
    } catch (err) {
      // Non-fatal: if migration fails, integrations will need to be re-attached manually.
      console.error('[createSession] Failed to migrate integrations:', err);
    }

    // Auto-apply dashboard secrets to the new session
    try {
      const { getSecretsWithProtection, getApprovedDomainsForDashboard } = await import('../secrets/handler');
      const secrets = await getSecretsWithProtection(env, userId, dashboardId);
      const approvedDomains = await getApprovedDomainsForDashboard(env, userId, dashboardId);
      const secretNames = Object.keys(secrets);
      if (secretNames.length > 0 || approvedDomains.length > 0) {
        // Convert to the format expected by sandbox: { name: { value, brokerProtected } }
        // applyNow: true because the PTY is already running at this point —
        // .env was empty when the PTY started, so we must inject env vars into the live shell
        await sandbox.updateEnv(
          sandboxSessionId,
          {
            secrets: secretNames.length > 0 ? secrets : undefined,
            approvedDomains: approvedDomains.length > 0 ? approvedDomains : undefined,
            applyNow: true,
          },
          sandboxMachineId || undefined
        );
      }
      // Track applied secret names for deletion tracking (upsert in case row exists from sandbox creation)
      await env.DB.prepare(`
        INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(dashboard_id) DO UPDATE SET applied_secret_names = excluded.applied_secret_names
      `).bind(dashboardId, sandboxSessionId, sandboxMachineId || '', JSON.stringify(secretNames), now).run();
    } catch (err) {
      console.error('Failed to auto-apply secrets:', err);
      // Non-fatal - continue with session creation
    }

    const session: Session = {
      id,
      dashboardId,
      itemId,
      ownerUserId: userId,
      ownerName: userName,
      sandboxSessionId: sandboxSessionId,
      sandboxMachineId: sandboxMachineId,
      ptyId: pty.id,
      status: 'active',
      region: 'local',
      createdAt: now,
      stoppedAt: null,
    };

    // Notify Durable Object
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request('http://do/session', {
      method: 'PUT',
      body: JSON.stringify(session),
    }));

    try {
      await triggerDriveMirrorSync(env, dashboardId, sandboxSessionId, sandboxMachineId);
    } catch {
      // Best-effort drive hydration.
    }

    try {
      const githubMirror = await env.DB.prepare(`
        SELECT repo_owner, repo_name FROM github_mirrors
        WHERE dashboard_id = ?
      `).bind(dashboardId).first<{ repo_owner: string; repo_name: string }>();
      if (githubMirror) {
        await triggerMirrorSync(
          env,
          'github',
          dashboardId,
          sandboxSessionId,
          sandboxMachineId,
          `${githubMirror.repo_owner}/${githubMirror.repo_name}`
        );
      }
    } catch {
      // Best-effort github hydration.
    }

    try {
      const boxMirror = await env.DB.prepare(`
        SELECT folder_name FROM box_mirrors
        WHERE dashboard_id = ?
      `).bind(dashboardId).first<{ folder_name: string }>();
      if (boxMirror) {
        await triggerMirrorSync(
          env,
          'box',
          dashboardId,
          sandboxSessionId,
          sandboxMachineId,
          boxMirror.folder_name
        );
      }
    } catch {
      // Best-effort box hydration.
    }

    try {
      const onedriveMirror = await env.DB.prepare(`
        SELECT folder_name FROM onedrive_mirrors
        WHERE dashboard_id = ?
      `).bind(dashboardId).first<{ folder_name: string }>();
      if (onedriveMirror) {
        await triggerMirrorSync(
          env,
          'onedrive',
          dashboardId,
          sandboxSessionId,
          sandboxMachineId,
          onedriveMirror.folder_name
        );
      }
    } catch {
      // Best-effort onedrive hydration.
    }

    // Log terminal.created analytics event via waitUntil so Workers doesn't drop it
    const createdEventPromise = logServerEvent(env.DB, userId, 'terminal.created', dashboardId, {
      itemId,
      agentType,
    }).catch(() => {});
    if (ctx) ctx.waitUntil(createdEventPromise);


    return Response.json({ session }, { status: 201 });
  } catch (error) {
    console.error(`[createSession] FAILED dashboardId=${dashboardId} itemId=${itemId} sandboxUrl=${env.SANDBOX_URL} error=`, error);
    // Update status to error
    await env.DB.prepare(`
      UPDATE sessions SET status = 'error' WHERE id = ?
    `).bind(id).run();

    return Response.json({
      error: `Failed to create sandbox session: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, { status: 500 });
  }
}

export async function startDashbоardBrowser(
  env: EnvWithDriveCache,
  dashboardId: string,
  userId: string,
  preferredRegion?: string
): Promise<Response> {
  const sandboxInfo = await ensureDashbоardSandbоx(env, dashboardId, userId, preferredRegion);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }

  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const statusResponse = await sandboxFetch(
    env,
    `/sessions/${sandboxSessionId}/browser/status`,
    { machineId: sandboxMachineId || undefined }
  );

  if (statusResponse.ok) {
    try {
      const status = await statusResponse.json() as { running?: boolean };
      if (status?.running) {
        return Response.json({ status: 'running' });
      }
    } catch {
      // fall through to start
    }
  }

  const response = await sandboxFetch(env, `/sessions/${sandboxSessionId}/browser/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    machineId: sandboxMachineId || undefined,
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }
    return Response.json(
      { error: 'E79815: Failed to start browser', detail: detail || undefined },
      { status: 500 }
    );
  }

  return Response.json({ status: 'starting' });
}

export async function stоpDashbоardBrowser(
  env: EnvWithDriveCache,
  dashboardId: string,
  userId: string,
  preferredRegion?: string
): Promise<Response> {
  const sandboxInfo = await ensureDashbоardSandbоx(env, dashboardId, userId, preferredRegion);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }

  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  await sandboxFetch(env, `/sessions/${sandboxSessionId}/browser/stop`, {
    method: 'POST',
    machineId: sandboxMachineId || undefined,
  });

  return new Response(null, { status: 204 });
}

export async function getDashbоardBrowserStatus(
  env: EnvWithDriveCache,
  dashboardId: string,
  userId: string,
  preferredRegion?: string
): Promise<Response> {
  const sandboxInfo = await ensureDashbоardSandbоx(env, dashboardId, userId, preferredRegion);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }

  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const response = await sandboxFetch(
    env,
    `/sessions/${sandboxSessionId}/browser/status`,
    { machineId: sandboxMachineId || undefined }
  );

  if (!response.ok) {
    return Response.json({ running: false }, { status: 200 });
  }

  return response;
}

export async function openDashbоardBrowser(
  env: EnvWithDriveCache,
  dashboardId: string,
  userId: string,
  url: string,
  preferredRegion?: string
): Promise<Response> {
  const sandboxInfo = await ensureDashbоardSandbоx(env, dashboardId, userId, preferredRegion);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }

  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const response = await sandboxFetch(env, `/sessions/${sandboxSessionId}/browser/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
    machineId: sandboxMachineId || undefined,
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }
    return Response.json(
      { error: 'E79817: Failed to open browser URL', detail: detail || undefined },
      { status: 500 }
    );
  }

  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request('http://do/browser', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }));

  return new Response(null, { status: 204 });
}

export async function openBrowserFromSandbоxSessionInternal(
  env: EnvWithDriveCache,
  sandboxSessionId: string,
  url: string,
  ptyId?: string
): Promise<Response> {
  if (!sandboxSessionId || !url) {
    return Response.json({ error: 'E79821: Missing session or URL' }, { status: 400 });
  }

  // If pty_id is provided, look up the exact session for this terminal.
  // All terminals in a dashboard share the same sandbox_session_id, so without
  // pty_id the query returns the most recently created session (wrong terminal).
  let session: { dashboard_id: string; item_id: string } | null = null;
  if (ptyId) {
    session = await env.DB.prepare(`
      SELECT dashboard_id, item_id FROM sessions WHERE sandbox_session_id = ? AND pty_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(sandboxSessionId, ptyId).first<{ dashboard_id: string; item_id: string }>();
  }
  if (!session) {
    session = await env.DB.prepare(`
      SELECT dashboard_id, item_id FROM sessions WHERE sandbox_session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(sandboxSessionId).first<{ dashboard_id: string; item_id: string }>();
  }

  if (!session?.dashboard_id) {
    return Response.json({ error: 'E79820: Session not found' }, { status: 404 });
  }

  const dashboardId = session.dashboard_id;
  const terminalItemId = session.item_id;
  const now = new Date().toISOString();
  const existingBrowser = await env.DB.prepare(`
    SELECT * FROM dashboard_items
    WHERE dashboard_id = ? AND type = 'browser'
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(dashboardId).first();

  let browserItemId = existingBrowser?.id as string | undefined;
  if (browserItemId) {
    await env.DB.prepare(`
      UPDATE dashboard_items
      SET content = ?, updated_at = ?
      WHERE id = ?
    `).bind(url, now, browserItemId).run();
  } else {
    // Use the specific terminal that triggered the browser open (by item_id),
    // falling back to the most recently updated terminal if not found.
    const terminalAnchor = terminalItemId
      ? await env.DB.prepare(`
          SELECT position_x, position_y, width FROM dashboard_items WHERE id = ?
        `).bind(terminalItemId).first<{
          position_x: number | null;
          position_y: number | null;
          width: number | null;
        }>()
      : await env.DB.prepare(`
          SELECT position_x, position_y, width FROM dashboard_items
          WHERE dashboard_id = ? AND type = 'terminal'
          ORDER BY updated_at DESC
          LIMIT 1
        `).bind(dashboardId).first<{
          position_x: number | null;
          position_y: number | null;
          width: number | null;
        }>();
    const anchorX = typeof terminalAnchor?.position_x === 'number' ? terminalAnchor.position_x : 140;
    const anchorY = typeof terminalAnchor?.position_y === 'number' ? terminalAnchor.position_y : 140;
    const anchorWidth = typeof terminalAnchor?.width === 'number' ? terminalAnchor.width : 520;
    const positionX = anchorX + anchorWidth + 24;
    const positionY = anchorY;
    browserItemId = generateId();
    await env.DB.prepare(`
      INSERT INTO dashboard_items
        (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      browserItemId,
      dashboardId,
      'browser',
      url,
      positionX,
      positionY,
      800,
      500,
      now,
      now
    ).run();
  }

  await env.DB.prepare(`
    UPDATE dashboards SET updated_at = ? WHERE id = ?
  `).bind(now, dashboardId).run();

  const savedItem = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ?
  `).bind(browserItemId).first();

  const formattedItem = savedItem ? fоrmatDashbоardItem(savedItem) : null;

  // Create edge from terminal to browser (right-out -> left-in) if this is a new browser
  let formattedEdge: {
    id: string;
    dashboardId: string;
    sourceItemId: string;
    targetItemId: string;
    sourceHandle: string;
    targetHandle: string;
    createdAt: string;
    updatedAt: string;
  } | null = null;

  if (!existingBrowser && terminalItemId && browserItemId) {
    // Check if edge already exists
    const existingEdge = await env.DB.prepare(`
      SELECT * FROM dashboard_edges
      WHERE dashboard_id = ?
        AND source_item_id = ?
        AND target_item_id = ?
        AND COALESCE(source_handle, '') = 'right-out'
        AND COALESCE(target_handle, '') = 'left-in'
    `).bind(dashboardId, terminalItemId, browserItemId).first();

    if (!existingEdge) {
      const edgeId = generateId();
      await env.DB.prepare(`
        INSERT INTO dashboard_edges
          (id, dashboard_id, source_item_id, target_item_id, source_handle, target_handle, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        edgeId,
        dashboardId,
        terminalItemId,
        browserItemId,
        'right-out',
        'left-in',
        now,
        now
      ).run();

      formattedEdge = {
        id: edgeId,
        dashboardId,
        sourceItemId: terminalItemId,
        targetItemId: browserItemId,
        sourceHandle: 'right-out',
        targetHandle: 'left-in',
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  if (formattedItem) {
    await stub.fetch(new Request('http://do/item', {
      method: existingBrowser ? 'PUT' : 'POST',
      body: JSON.stringify(formattedItem),
    }));
  }
  // Notify DO about the new edge
  if (formattedEdge) {
    await stub.fetch(new Request('http://do/edge', {
      method: 'POST',
      body: JSON.stringify(formattedEdge),
    }));
  }
  await stub.fetch(new Request('http://do/browser', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }));

  return new Response(null, { status: 204 });
}

// Get session for an item
export async function getSessiоn(
  env: EnvWithDriveCache,
  sessionId: string,
  userId: string
): Promise<Response> {
  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ?
  `).bind(sessionId, userId).first();

  if (!session) {
    return Response.json({ error: 'E79203: Session not found or no access' }, { status: 404 });
  }

  return Response.json({
    session: {
      id: session.id,
      dashboardId: session.dashboard_id,
      itemId: session.item_id,
      ownerUserId: session.owner_user_id,
      ownerName: session.owner_name,
      sandboxSessionId: session.sandbox_session_id,
      sandboxMachineId: session.sandbox_machine_id,
      ptyId: session.pty_id,
      status: session.status,
      region: session.region,
      createdAt: session.created_at,
      stoppedAt: session.stopped_at,
    }
  });
}

export async function updateSessiоnEnv(
  env: EnvWithDriveCache,
  sessionId: string,
  userId: string,
  payload: { set?: Record<string, string>; unset?: string[]; applyNow?: boolean }
): Promise<Response> {
  const session = await env.DB.prepare(`
    SELECT s.* FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ? AND dm.role IN ('owner', 'editor')
  `).bind(sessionId, userId).first();

  if (!session) {
    return Response.json({ error: 'E79214: Session not found or no access' }, { status: 404 });
  }

  const set = payload.set || {};
  const unset = payload.unset || [];
  const hasSet = Object.keys(set).length > 0;
  const hasUnset = unset.length > 0;
  if (!hasSet && !hasUnset) {
    return Response.json({ error: 'E79215: No env updates provided' }, { status: 400 });
  }

  for (const [key, value] of Object.entries(set)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return Response.json({ error: 'E79216: Invalid env payload' }, { status: 400 });
    }
  }
  for (const key of unset) {
    if (typeof key !== 'string') {
      return Response.json({ error: 'E79216: Invalid env payload' }, { status: 400 });
    }
  }

  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  await sandbox.updateEnv(
    session.sandbox_session_id as string,
    { set, unset, applyNow: payload.applyNow },
    (session.sandbox_machine_id as string) || undefined
  );

  return Response.json({ status: 'ok' });
}

// Stop a session
export async function stоpSessiоn(
  env: EnvWithDriveCache,
  sessionId: string,
  userId: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>
): Promise<Response> {
  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ? AND dm.role IN ('owner', 'editor')
  `).bind(sessionId, userId).first();

  if (!session) {
    return Response.json({ error: 'E79203: Session not found or no access' }, { status: 404 });
  }

  if (session.status === 'stopped') {
    return Response.json({ error: 'E79204: Session already stopped' }, { status: 400 });
  }

  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  // REVISION: preserve-sandbox-v1-stop-keeps-sandbox
  // Preserve the sandbox (and dashboard_sandboxes mapping) when stopping the last session.
  // This keeps the Fly machine pinned so restarts reuse the same machine (avoids
  // routing to a different machine that may lack agent binaries like gemini).
  // Fly auto_stop_machines handles cleanup when idle; stale-sandbox 404 recovery
  // in createSession handles cases where the machine was auto-stopped.
  try {
    const otherSessions = await env.DB.prepare(`
      SELECT COUNT(1) as count FROM sessions
      WHERE dashboard_id = ? AND status IN ('creating', 'active') AND id != ?
    `).bind(session.dashboard_id, sessionId).first<{ count: number }>();

    if (!otherSessions || otherSessions.count === 0) {
      // Capture workspace snapshot for recovery, but preserve the sandbox.
      await captureWorkspaceSnapshot(
        env,
        session.dashboard_id as string,
        session.sandbox_session_id as string,
        session.sandbox_machine_id as string
      );
    }

    // Always just delete this session's PTY (not the sandbox session)
    if (session.pty_id) {
      await sandbox.deletePty(session.sandbox_session_id as string, session.pty_id as string);
    }
  } catch {
    // Ignore errors - sandbox might already be gone
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE id = ?
  `).bind(now, sessionId).run();

  const updatedSession: Session = {
    id: session.id as string,
    dashboardId: session.dashboard_id as string,
    itemId: session.item_id as string,
    ownerUserId: session.owner_user_id as string,
    ownerName: session.owner_name as string,
    sandboxSessionId: session.sandbox_session_id as string,
    sandboxMachineId: session.sandbox_machine_id as string,
    ptyId: session.pty_id as string,
    status: 'stopped',
    region: session.region as string,
    createdAt: session.created_at as string,
    stoppedAt: now,
  };

  // Notify Durable Object
  const doId = env.DASHBOARD.idFromName(session.dashboard_id as string);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request('http://do/session', {
    method: 'PUT',
    body: JSON.stringify(updatedSession),
  }));

  // Log terminal.stopped analytics event via waitUntil so Workers doesn't drop it
  const createdAt = new Date(session.created_at as string).getTime();
  const stoppedAt = new Date(now).getTime();
  const durationMs = stoppedAt - createdAt;
  const stoppedEventPromise = logServerEvent(env.DB, userId, 'terminal.stopped', session.dashboard_id as string, {
    sessionId,
    agentType: session.agent_type as string | null,
    durationMs,
  }).catch(() => {});
  if (ctx) ctx.waitUntil(stoppedEventPromise);

  return new Response(null, { status: 204 });
}

// REVISION: sandbox-keepalive-v1-prevent-autostop
/**
 * Ping the sandbox to keep the Fly machine alive.
 * Called by the frontend while the dashboard is open after the last terminal closes,
 * preventing Fly auto_stop_machines from killing the sandbox for up to 5 minutes.
 * When the user closes the browser tab, pings stop and Fly auto-stops naturally.
 */
export async function sandboxKeepalive(
  env: EnvWithDriveCache,
  dashboardId: string,
  userId: string
): Promise<Response> {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79750: Not found or no access' }, { status: 404 });
  }

  const sandboxInfo = await getDashbоardSandbоx(env, dashboardId);
  if (!sandboxInfo?.sandbox_session_id) {
    return Response.json({ error: 'E79751: No sandbox for this dashboard' }, { status: 404 });
  }

  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const healthy = await sandbox.health(sandboxInfo.sandbox_machine_id || undefined);

  return Response.json({ alive: healthy });
}

/**
 * Get cached workspace file listing from R2.
 * Returns the snapshot if available, 404 otherwise.
 */
export async function getWorkspaceSnapshot(
  env: EnvWithDriveCache,
  dashboardId: string,
  userId: string
): Promise<Response> {
  // Verify user has access to this dashboard
  const member = await env.DB.prepare(`
    SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!member) {
    return Response.json({ error: 'E79740: Dashboard not found or no access' }, { status: 404 });
  }

  let object: R2ObjectBody | null;
  try {
    object = await env.DRIVE_CACHE.get(workspaceSnapshotKey(dashboardId));
  } catch (error) {
    if (isDesktopFeatureDisabledError(error)) {
      return Response.json({ error: 'E79741: No workspace snapshot available (desktop mode)' }, { status: 404 });
    }
    throw error;
  }
  if (!object) {
    return Response.json({ error: 'E79741: No workspace snapshot available' }, { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  return new Response(object.body, { headers });
}

// Apply stored secrets to a session as environment variables
export async function applySecretsToSession(
  env: EnvWithDriveCache,
  sessionId: string,
  userId: string
): Promise<Response> {
  // Import dynamically to avoid circular dependency
  const { getSecretsWithProtection, getApprovedDomainsForDashboard } = await import('../secrets/handler');

  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ? AND dm.role IN ('owner', 'editor')
  `).bind(sessionId, userId).first();

  if (!session) {
    return Response.json({ error: 'E79217: Session not found or no access' }, { status: 404 });
  }

  if (session.status !== 'active') {
    return Response.json({ error: 'E79218: Session is not active' }, { status: 400 });
  }

  try {
    const secrets = await getSecretsWithProtection(
      env,
      userId,
      session.dashboard_id as string
    );

    // Get approved domains for custom secrets
    const approvedDomains = await getApprovedDomainsForDashboard(
      env,
      userId,
      session.dashboard_id as string
    );

    // Get previously applied secret names to compute what to unset
    const dashboardSandbox = await env.DB.prepare(`
      SELECT applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(session.dashboard_id).first<{ applied_secret_names: string }>();

    const previousNames: string[] = dashboardSandbox?.applied_secret_names
      ? JSON.parse(dashboardSandbox.applied_secret_names)
      : [];
    const currentNames = Object.keys(secrets);

    // Compute secrets to unset (were applied before but not in current set)
    const unset: string[] = [];
    for (const name of previousNames) {
      if (!currentNames.includes(name)) {
        unset.push(name);
        // Also unset the _BROKER suffix for custom secrets
        unset.push(`${name}_BROKER`);
      }
    }

    // Update the applied secret names for next time (upsert in case row doesn't exist)
    await env.DB.prepare(`
      INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, applied_secret_names)
      VALUES (?, ?, ?)
      ON CONFLICT(dashboard_id) DO UPDATE SET applied_secret_names = excluded.applied_secret_names
    `).bind(session.dashboard_id, session.sandbox_session_id, JSON.stringify(currentNames)).run();

    // Skip updateEnv call if there's nothing to do
    const hasSecrets = Object.keys(secrets).length > 0;
    const hasUnset = unset.length > 0;
    const hasApprovedDomains = approvedDomains.length > 0;

    if (!hasSecrets && !hasUnset && !hasApprovedDomains) {
      // Nothing to apply - return success without calling sandbox
      return Response.json({ applied: 0, approvedDomains: 0, unset: 0 });
    }

    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
    // Don't use applyNow - new PTYs will load from .env automatically
    // Existing PTYs can run `source ~/.env` if needed
    await sandbox.updateEnv(
      session.sandbox_session_id as string,
      {
        secrets: hasSecrets ? secrets : undefined,
        approvedDomains: hasApprovedDomains ? approvedDomains : undefined,
        unset: hasUnset ? unset : undefined,
        applyNow: false,
      },
      (session.sandbox_machine_id as string) || undefined
    );

    return Response.json({ applied: Object.keys(secrets).length, approvedDomains: approvedDomains.length, unset: unset.length });
  } catch (error) {
    console.error('Failed to apply secrets:', error);
    return Response.json(
      { error: 'E79219: Failed to apply secrets' },
      { status: 500 }
    );
  }
}

// ============================================
// Internal routes for sandbox-to-controlplane communication
// ============================================

/**
 * Create a pending approval request for a custom secret domain.
 * Called by sandbox broker when a request is made to an unapproved domain.
 * Internal endpoint - no user auth, uses X-Internal-Token.
 */
export async function createApprovalRequestInternal(
  env: EnvWithDriveCache,
  sandboxSessionId: string,
  data: { secretName: string; domain: string }
): Promise<Response> {
  const { secretName, domain } = data;

  if (!secretName || !domain) {
    return Response.json(
      { error: 'E79220: secretName and domain are required' },
      { status: 400 }
    );
  }

  // Find the dashboard from the sandbox session
  let dashboardId: string | undefined;

  const session = await env.DB.prepare(`
    SELECT dashboard_id FROM sessions WHERE sandbox_session_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(sandboxSessionId).first<{ dashboard_id: string }>();

  if (session?.dashboard_id) {
    dashboardId = session.dashboard_id;
  } else {
    // Also check dashboard_sandboxes in case no PTY session exists yet
    const sandbox = await env.DB.prepare(`
      SELECT dashboard_id FROM dashboard_sandboxes WHERE sandbox_session_id = ?
    `).bind(sandboxSessionId).first<{ dashboard_id: string }>();

    if (!sandbox?.dashboard_id) {
      return Response.json(
        { error: 'E79221: Session not found' },
        { status: 404 }
      );
    }

    dashboardId = sandbox.dashboard_id;
  }

  // Get the dashboard owner to find their secrets
  const dashboard = await env.DB.prepare(`
    SELECT owner_id FROM dashboards WHERE id = ?
  `).bind(dashboardId).first<{ owner_id: string }>();

  if (!dashboard?.owner_id) {
    return Response.json(
      { error: 'E79222: Dashboard not found' },
      { status: 404 }
    );
  }

  const userId = dashboard.owner_id;

  // Find the secret by name - check both dashboard-specific and global secrets
  const secret = await env.DB.prepare(`
    SELECT id, name FROM user_secrets
    WHERE user_id = ? AND name = ? AND (dashboard_id = ? OR dashboard_id = '_global')
    ORDER BY CASE WHEN dashboard_id = ? THEN 1 ELSE 0 END DESC
    LIMIT 1
  `).bind(userId, secretName, dashboardId, dashboardId).first<{ id: string; name: string }>();

  if (!secret?.id) {
    return Response.json(
      { error: 'E79223: Secret not found' },
      { status: 404 }
    );
  }

  // Check if already pending or approved
  const existingPending = await env.DB.prepare(`
    SELECT id FROM pending_domain_approvals
    WHERE secret_id = ? AND domain = ? AND dismissed_at IS NULL
  `).bind(secret.id, domain.toLowerCase()).first();

  if (existingPending) {
    return Response.json({ status: 'already_pending' });
  }

  const existingApproval = await env.DB.prepare(`
    SELECT id FROM user_secret_allowlist
    WHERE secret_id = ? AND domain = ? AND revoked_at IS NULL
  `).bind(secret.id, domain.toLowerCase()).first();

  if (existingApproval) {
    return Response.json({ status: 'already_approved' });
  }

  // Create pending approval
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO pending_domain_approvals (id, secret_id, domain, requested_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(id, secret.id, domain.toLowerCase()).run();

  // Notify Dashboard DO to push update to connected clients
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request('http://do/pending-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretName, domain: domain.toLowerCase() }),
    }));
  } catch (e) {
    // Non-fatal - approval is created, just couldn't push notification
    console.warn('[approval] Failed to push notification to DO:', e);
  }

  return Response.json({ status: 'pending', id });
}

/**
 * Get approved domain configurations for a sandbox session.
 * Returns all approved domains for custom secrets in the dashboard.
 * Internal endpoint - no user auth, uses X-Internal-Token.
 */
export async function getApprovedDomainsInternal(
  env: EnvWithDriveCache,
  sandboxSessionId: string
): Promise<Response> {
  // Find the dashboard from the sandbox session
  const session = await env.DB.prepare(`
    SELECT dashboard_id FROM sessions WHERE sandbox_session_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(sandboxSessionId).first<{ dashboard_id: string }>();

  let dashboardId = session?.dashboard_id;

  if (!dashboardId) {
    // Also check dashboard_sandboxes
    const sandbox = await env.DB.prepare(`
      SELECT dashboard_id FROM dashboard_sandboxes WHERE sandbox_session_id = ?
    `).bind(sandboxSessionId).first<{ dashboard_id: string }>();

    dashboardId = sandbox?.dashboard_id;
  }

  if (!dashboardId) {
    return Response.json(
      { error: 'E79224: Session not found' },
      { status: 404 }
    );
  }

  // Get the dashboard owner
  const dashboard = await env.DB.prepare(`
    SELECT owner_id FROM dashboards WHERE id = ?
  `).bind(dashboardId).first<{ owner_id: string }>();

  if (!dashboard?.owner_id) {
    return Response.json(
      { error: 'E79225: Dashboard not found' },
      { status: 404 }
    );
  }

  const userId = dashboard.owner_id;

  // Get all approved domains for secrets belonging to this user (dashboard + global)
  // Join with user_secrets to get the secret name
  const approvals = await env.DB.prepare(`
    SELECT
      s.name as secret_name,
      a.domain,
      a.header_name,
      a.header_format
    FROM user_secret_allowlist a
    JOIN user_secrets s ON a.secret_id = s.id
    WHERE s.user_id = ?
      AND (s.dashboard_id = ? OR s.dashboard_id = '_global')
      AND a.revoked_at IS NULL
  `).bind(userId, dashboardId).all();

  const result = approvals.results.map(row => ({
    secretName: row.secret_name as string,
    domain: row.domain as string,
    headerName: row.header_name as string,
    headerFormat: row.header_format as string,
  }));

  return Response.json({ approvedDomains: result });
}
