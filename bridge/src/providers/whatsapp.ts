// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: whatsapp-provider-v15-strip-pii-from-logs
console.log(`[whatsapp-provider] REVISION: whatsapp-provider-v15-strip-pii-from-logs loaded at ${new Date().toISOString()}`);

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  getContentType,
  Browsers,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { mkdirSync } from 'fs';
import type { BridgeProvider, SessionManager, NormalizedMessage } from '../session-manager.js';

const logger = pino({ level: 'silent' });

const MAX_RECONNECT_RETRIES = 8;
const BASE_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

/** Handshake sentinel — never delivered to terminals */
const HANDSHAKE_TEXT = '__orcabot_handshake__';
const HANDSHAKE_REPLY = 'Connected to OrcaBot';
const HANDSHAKE_MESSAGES = new Set([HANDSHAKE_TEXT, HANDSHAKE_REPLY]);

export interface HybridConfig {
  hybridMode?: boolean;
  /** Business phone JID, e.g. "15551234567@s.whatsapp.net" */
  businessPhoneJid?: string;
}

export class WhatsAppProvider implements BridgeProvider {
  private sock: WASocket | null = null;
  private currentQr: string | null = null;
  private status: 'connecting' | 'connected' | 'disconnected' | 'error' = 'connecting';
  private stopped = false;
  private starting = false;
  private reconnectAttempts = 0;
  private authDir: string;

  // Auth state loaded once and reused across reconnects
  private authState: Awaited<ReturnType<typeof useMultiFileAuthState>> | null = null;

  // WhatsApp LID (Linked ID) for the business phone, resolved at runtime.
  // Baileys may use opaque LIDs (e.g. "56574013915191@lid") instead of phone JIDs
  // (e.g. "447400853301@s.whatsapp.net"). We capture the LID during handshake.
  private resolvedBusinessLid: string | null = null;

  constructor(
    private sessionId: string,
    private userId: string,
    private dataDir: string,
    private sessionManager: SessionManager,
    private config?: HybridConfig,
  ) {
    // Auth dir scoped by sessionId (not just userId) to prevent credential
    // collisions when the same user has multiple WhatsApp blocks/connections.
    this.authDir = `${dataDir}/whatsapp-sessions/${userId}/${sessionId}`;
  }

  async start(): Promise<void> {
    // Guard against overlapping start() calls (e.g. rapid reconnects)
    if (this.starting) {
      console.warn(`[whatsapp] Session ${this.sessionId} start() already in progress, skipping`);
      return;
    }
    this.starting = true;

    try {
      // Tear down existing socket before creating a new one
      this.teardownSocket();

      mkdirSync(this.authDir, { recursive: true });

      // Load auth state once on first start; reuse on reconnects so identity keys persist
      if (!this.authState) {
        this.authState = await useMultiFileAuthState(this.authDir);
      }

      const { state, saveCreds } = this.authState;

      this.sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
      });

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.currentQr = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error(`[whatsapp] Failed to generate QR data URL:`, err);
          }
        }

        if (connection === 'open') {
          this.currentQr = null;
          this.status = 'connected';
          this.reconnectAttempts = 0;
          this.sessionManager.updateSessionStatus(this.sessionId, 'connected');
          console.log(`[whatsapp] Session ${this.sessionId} connected`);

          // In hybrid mode, resolve business phone LID and initiate handshake
          if (this.config?.hybridMode && this.config.businessPhoneJid) {
            // Proactively resolve the LID for the business phone number
            this.resolveBusinessLid().catch(err => {
              console.warn(`[whatsapp] LID resolution failed (will capture from handshake):`, err);
            });
            this.performHandshake().catch(err => {
              console.error(`[whatsapp] Handshake failed for session ${this.sessionId}:`, err);
            });
          }
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut || this.stopped) {
            this.status = 'disconnected';
            this.sessionManager.updateSessionStatus(
              this.sessionId,
              'disconnected',
              loggedOut ? 'Logged out from WhatsApp' : 'Stopped',
            );
            console.log(`[whatsapp] Session ${this.sessionId} disconnected (logged out: ${loggedOut})`);
          } else {
            this.reconnectAttempts++;

            if (this.reconnectAttempts > MAX_RECONNECT_RETRIES) {
              console.error(`[whatsapp] Session ${this.sessionId} exceeded ${MAX_RECONNECT_RETRIES} reconnect attempts, giving up`);
              this.status = 'error';
              this.sessionManager.updateSessionStatus(
                this.sessionId,
                'error',
                `Connection failed after ${MAX_RECONNECT_RETRIES} attempts`,
              );
              return;
            }

            const delay = Math.min(
              BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
              MAX_RECONNECT_DELAY_MS,
            );
            console.log(`[whatsapp] Session ${this.sessionId} connection closed, reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_RETRIES})...`);
            this.status = 'connecting';
            this.sessionManager.updateSessionStatus(this.sessionId, 'connecting');
            setTimeout(() => {
              if (!this.stopped) this.start().catch(console.error);
            }, delay);
          }
        }
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          if (!msg.message) continue;

          const remoteJid = msg.key.remoteJid;
          const fromMe = msg.key.fromMe;
          // Log message routing without content (privacy: bridge sees all personal messages)
          console.log(`[whatsapp] Message: from=${fromMe ? 'me' : 'other'} hybrid=${!!this.config?.hybridMode}`);

          // Skip non-chat JIDs (newsletters, broadcast lists) — these are not conversations
          if (remoteJid?.endsWith('@newsletter') || remoteJid?.endsWith('@broadcast')) {
            console.log(`[whatsapp] Skipping non-chat JID: ${remoteJid}`);
            continue;
          }

          const text = this.extractText(msg);

          if (msg.key.fromMe) {
            // In hybrid mode, capture outgoing messages sent TO the OrcaBot business number
            if (this.config?.hybridMode && this.config.businessPhoneJid) {
              const isBusinessTarget = remoteJid === this.config.businessPhoneJid
                || (this.resolvedBusinessLid && remoteJid === this.resolvedBusinessLid);

              if (isBusinessTarget) {
                if (text && HANDSHAKE_MESSAGES.has(text.trim())) {
                  // Capture LID from handshake for future comparisons
                  if (!this.resolvedBusinessLid && remoteJid !== this.config.businessPhoneJid) {
                    this.resolvedBusinessLid = remoteJid!;
                    console.log(`[whatsapp] Captured business LID from handshake: ${this.resolvedBusinessLid}`);
                  }
                } else if (text) {
                  const normalized = this.normalizeOutgoingMessage(msg);
                  if (normalized) {
                    console.log(`[whatsapp] Forwarding outgoing to OrcaBot`);
                    void this.sessionManager.forwardMessage(this.sessionId, normalized);
                  }
                }
              } else if (!this.resolvedBusinessLid && text && HANDSHAKE_MESSAGES.has(text.trim())) {
                this.resolvedBusinessLid = remoteJid!;
                console.log(`[whatsapp] Captured business LID from handshake: ${this.resolvedBusinessLid}`);
              }
            }
            continue;
          }

          // In hybrid mode: capture business LID from handshake reply, and
          // filter out OrcaBot's own replies (Business API messages echoing back)
          if (this.config?.hybridMode) {
            // Capture business LID from handshake reply BEFORE the isFromBusiness check.
            // The LID is an opaque identifier (e.g. "56574013915191@lid") that WhatsApp uses
            // instead of the phone-based JID. We capture it from the handshake reply
            // ("Connected to OrcaBot") sent by a JID we don't yet recognize as the business number.
            if (!this.resolvedBusinessLid && text && HANDSHAKE_MESSAGES.has(text.trim())
                && remoteJid && remoteJid !== this.config.businessPhoneJid) {
              this.resolvedBusinessLid = remoteJid;
              console.log(`[whatsapp] Captured business LID from handshake reply`);
              continue; // Don't forward handshake sentinel
            }

            const isFromBusiness = remoteJid === this.resolvedBusinessLid
              || remoteJid === this.config.businessPhoneJid;

            if (isFromBusiness) {
              // Skip all messages from the business number (OrcaBot's own replies)
              continue;
            }
          }

          const normalized = this.normalizeMessage(msg);
          if (normalized) {
            console.log(`[whatsapp] Forwarding inbound message`);
            void this.sessionManager.forwardMessage(this.sessionId, normalized);
          }
        }
      });
    } finally {
      this.starting = false;
    }
  }

  /** Tear down the current socket and its listeners without changing stopped flag */
  private teardownSocket(): void {
    if (this.sock) {
      this.sock.ev.removeAllListeners('connection.update');
      this.sock.ev.removeAllListeners('creds.update');
      this.sock.ev.removeAllListeners('messages.upsert');
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<{ messageId: string }> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error(`WhatsApp not connected (status: ${this.status})`);
    }

    // Normalize JID: strip non-digits (handles "+1 555-123-4567" style inputs)
    // then append @s.whatsapp.net for individual chats if missing
    const normalizedJid = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;

    const result = await this.sock.sendMessage(normalizedJid, { text });
    const messageId = result?.key?.id || '';
    console.log(`[whatsapp] Session ${this.sessionId} sent message: ${messageId}`);
    return { messageId };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.teardownSocket();
    this.status = 'disconnected';
  }

  getStatus(): 'connecting' | 'connected' | 'disconnected' | 'error' {
    return this.status;
  }

  getQrCode(): string | null {
    return this.currentQr;
  }

  /** Trigger a handshake with the business number (used for 24h window refresh) */
  async triggerHandshake(): Promise<boolean> {
    if (!this.config?.hybridMode || !this.config.businessPhoneJid) return false;
    await this.performHandshake();
    return true;
  }

  /** Resolve the LID (Linked ID) for the business phone number.
   *  Newer WhatsApp versions use opaque LIDs instead of phone-based JIDs. */
  private async resolveBusinessLid(): Promise<void> {
    if (!this.sock || !this.config?.businessPhoneJid || this.resolvedBusinessLid) return;

    try {
      // onWhatsApp checks if a number exists and returns its JID(s)
      const phone = this.config.businessPhoneJid.replace(/@s\.whatsapp\.net$/, '');
      const results = await this.sock.onWhatsApp(phone);
      if (results?.length) {
        const resolved = results[0].jid;
        if (resolved && resolved !== this.config.businessPhoneJid) {
          this.resolvedBusinessLid = resolved;
          console.log(`[whatsapp] Resolved business LID via onWhatsApp: ${this.config.businessPhoneJid} -> ${resolved}`);
        }
      }
    } catch (err) {
      console.warn(`[whatsapp] onWhatsApp resolution failed:`, err);
    }
  }

  /** Send handshake message to business number and notify control plane */
  private async performHandshake(): Promise<void> {
    if (!this.sock || !this.config?.businessPhoneJid) return;

    console.log(`[whatsapp] Initiating handshake with ${this.config.businessPhoneJid} for session ${this.sessionId}`);

    try {
      await this.sock.sendMessage(this.config.businessPhoneJid, { text: HANDSHAKE_TEXT });
      console.log(`[whatsapp] Handshake message sent for session ${this.sessionId}`);

      // Resolve the user's own phone number from the connected socket
      const myJid = this.sock.user?.id || '';
      const userPhone = myJid.replace(/@s\.whatsapp\.net$/, '').replace(/:\d+$/, '');

      // Notify control plane of handshake
      const handshakeNotification: NormalizedMessage = {
        provider: 'whatsapp',
        webhookId: this.sessionId,
        platformMessageId: `handshake-${Date.now()}`,
        senderId: userPhone || '__system__',
        senderName: this.sock.user?.name || 'system',
        channelId: '__handshake__',
        text: HANDSHAKE_TEXT,
        metadata: {
          source: 'bridge_handshake',
          isHandshake: true,
          userPhone,
          businessPhoneJid: this.config.businessPhoneJid,
        },
      };
      await this.sessionManager.forwardMessage(this.sessionId, handshakeNotification);
    } catch (err) {
      console.error(`[whatsapp] Failed to send handshake message for session ${this.sessionId}:`, err);
    }
  }

  /** Normalize an outgoing message (user → Orcabot business number) for control plane */
  private normalizeOutgoingMessage(msg: WAMessage): NormalizedMessage | null {
    const jid = msg.key.remoteJid;
    if (!jid) return null;

    const text = this.extractText(msg);
    if (!text) return null;

    // Sender is the connected user themselves
    const myJid = this.sock?.user?.id || '';
    const cleanSenderId = myJid.replace(/@s\.whatsapp\.net$/, '').replace(/:\d+$/, '');

    return {
      provider: 'whatsapp',
      webhookId: this.sessionId,
      platformMessageId: msg.key.id || `${Date.now()}`,
      senderId: cleanSenderId,
      senderName: this.sock?.user?.name || cleanSenderId,
      channelId: cleanSenderId, // Use sender's number as channel (for subscription routing)
      text,
      metadata: {
        source: 'bridge_outgoing',
        isOutgoing: true,
        isOrcabotChat: true,
        targetJid: jid,
      },
    };
  }

  private normalizeMessage(msg: WAMessage): NormalizedMessage | null {
    const jid = msg.key.remoteJid;
    if (!jid) return null;

    const text = this.extractText(msg);
    if (!text) return null;

    // Extract sender info
    // For group messages: participant is the actual sender, remoteJid is the group
    // For DMs: remoteJid is the sender
    const senderId = msg.key.participant || jid;
    const pushName = msg.pushName || senderId.split('@')[0];

    // Strip @s.whatsapp.net suffix for clean IDs
    const cleanSenderId = senderId.replace(/@s\.whatsapp\.net$/, '');
    const cleanChannelId = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');

    return {
      provider: 'whatsapp',
      webhookId: this.sessionId,
      platformMessageId: msg.key.id || `${Date.now()}`,
      senderId: cleanSenderId,
      senderName: pushName,
      channelId: cleanChannelId,
      text,
      metadata: {
        source: 'bridge',
        pushName,
        isGroup: jid.endsWith('@g.us'),
        isOrcabotChat: false,
        jid,
      },
    };
  }

  private extractText(msg: WAMessage): string | null {
    if (!msg.message) return null;

    const contentType = getContentType(msg.message);

    switch (contentType) {
      case 'conversation':
        return msg.message.conversation || null;
      case 'extendedTextMessage':
        return msg.message.extendedTextMessage?.text || null;
      case 'imageMessage':
        return msg.message.imageMessage?.caption || '<image>';
      case 'videoMessage':
        return msg.message.videoMessage?.caption || '<video>';
      case 'documentMessage':
        return msg.message.documentMessage?.caption || `<document: ${msg.message.documentMessage?.fileName || 'file'}>`;
      case 'audioMessage':
        return '<audio message>';
      case 'contactMessage':
        return `<contact: ${msg.message.contactMessage?.displayName || 'unknown'}>`;
      case 'locationMessage': {
        const loc = msg.message.locationMessage;
        return loc ? `<location: ${loc.degreesLatitude}, ${loc.degreesLongitude}>` : '<location>';
      }
      case 'stickerMessage':
        return '<sticker>';
      default:
        return null;
    }
  }
}
