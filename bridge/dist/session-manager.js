// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: session-manager-v7-clean-logging
console.log(`[session-manager] REVISION: session-manager-v7-clean-logging loaded at ${new Date().toISOString()}`);
import { WhatsAppProvider } from './providers/whatsapp.js';
// ---------- Session Manager ----------
export class SessionManager {
    dataDir;
    bridgeToken;
    sessions = new Map();
    constructor(dataDir, bridgeToken) {
        this.dataDir = dataDir;
        this.bridgeToken = bridgeToken;
    }
    async startSession(config) {
        // Stop existing session for same ID if any
        if (this.sessions.has(config.sessionId)) {
            await this.stopSession(config.sessionId);
        }
        const provider = this.createProvider(config);
        const session = {
            sessionId: config.sessionId,
            userId: config.userId,
            provider: config.provider,
            status: 'connecting',
            callbackUrl: config.callbackUrl,
            providerInstance: provider,
        };
        this.sessions.set(config.sessionId, session);
        try {
            await provider.start();
        }
        catch (err) {
            session.status = 'error';
            session.error = err instanceof Error ? err.message : 'Failed to start';
            console.error(`[session-manager] Failed to start session ${config.sessionId}:`, err);
        }
        return {
            sessionId: config.sessionId,
            status: session.status,
            qrCode: provider.getQrCode?.() ?? null,
        };
    }
    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new Error('Session not found');
        try {
            await session.providerInstance.stop();
        }
        catch (err) {
            console.error(`[session-manager] Error stopping session ${sessionId}:`, err);
        }
        this.sessions.delete(sessionId);
        console.log(`[session-manager] Session ${sessionId} stopped`);
    }
    async stopAll() {
        const ids = Array.from(this.sessions.keys());
        for (const id of ids) {
            await this.stopSession(id).catch(() => { });
        }
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    listSessions() {
        return Array.from(this.sessions.values()).map(s => ({
            sessionId: s.sessionId,
            userId: s.userId,
            provider: s.provider,
            status: s.status,
        }));
    }
    /** Called by provider instances when a message arrives */
    async forwardMessage(sessionId, message) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            console.warn(`[session-manager] forwardMessage for unknown session ${sessionId}`);
            return;
        }
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            const resp = await fetch(session.callbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Bridge-Token': this.bridgeToken,
                },
                body: JSON.stringify(message),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!resp.ok) {
                const respBody = await resp.text().catch(() => '');
                console.error(`[session-manager] Callback failed for session ${sessionId}: ${resp.status} ${respBody.slice(0, 200)}`);
            }
            session.lastMessageAt = new Date();
        }
        catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                console.error(`[session-manager] Callback timed out for session ${sessionId}`);
            }
            else {
                console.error(`[session-manager] Callback error for session ${sessionId}:`, err);
            }
        }
    }
    /** Called by provider instances when connection status changes */
    updateSessionStatus(sessionId, status, error) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        session.status = status;
        session.error = error;
        if (status === 'connected') {
            session.connectedAt = new Date();
        }
        console.log(`[session-manager] Session ${sessionId} status: ${status}${error ? ` (${error})` : ''}`);
    }
    createProvider(config) {
        switch (config.provider) {
            case 'whatsapp':
                return new WhatsAppProvider(config.sessionId, config.userId, this.dataDir, this, config.config);
            default:
                throw new Error(`Unsupported provider: ${config.provider}`);
        }
    }
}
//# sourceMappingURL=session-manager.js.map