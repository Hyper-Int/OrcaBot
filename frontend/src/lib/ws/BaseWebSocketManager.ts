// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Base WebSocket manager with connection state machine and reconnection logic
 *
 * Supports both binary and text (JSON) frames:
 * - Binary frames: handled via handleBinaryMessage()
 * - Text frames: handled via handleTextMessage()
 */

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface WebSocketConfig {
  /** Base reconnection delay in ms */
  reconnectBaseDelay?: number;
  /** Maximum reconnection delay in ms */
  reconnectMaxDelay?: number;
  /** Reconnection delay multiplier */
  reconnectMultiplier?: number;
  /** Maximum reconnection attempts before failing */
  maxReconnectAttempts?: number;
  /** Heartbeat interval in ms (0 to disable) */
  heartbeatInterval?: number;
}

const DEFAULT_CONFIG: Required<WebSocketConfig> = {
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 30000,
  reconnectMultiplier: 1.5,
  maxReconnectAttempts: 10,
  heartbeatInterval: 30000,
};

export type StateChangeHandler = (state: ConnectionState) => void;
export type ErrorHandler = (error: Error) => void;

export abstract class BaseWebSocketManager {
  protected ws: WebSocket | null = null;
  protected url: string;
  protected config: Required<WebSocketConfig>;
  protected state: ConnectionState = "disconnected";
  protected reconnectAttempts = 0;
  protected reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  protected heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

  // Event handlers
  protected onStateChangeHandlers: Set<StateChangeHandler> = new Set();
  protected onErrorHandlers: Set<ErrorHandler> = new Set();

  constructor(url: string, config: WebSocketConfig = {}) {
    this.url = url;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.state === "connected" || this.state === "connecting") {
      console.log(`[WS] Already ${this.state}, skipping connect`);
      return;
    }

    const newState = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    console.log(`[WS] Connecting to ${this.url} (attempt ${this.reconnectAttempts + 1})`);
    this.setState(newState);

    try {
      this.ws = new WebSocket(this.url);
      // Enable binary message handling
      this.ws.binaryType = "arraybuffer";
      this.setupEventListeners();
    } catch (error) {
      console.error(`[WS] Connection error:`, error);
      this.handleError(error as Error);
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    console.log(`[WS] Disconnecting (current state: ${this.state})`);
    this.clearTimers();
    this.reconnectAttempts = 0;

    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnection
      this.ws.close();
      this.ws = null;
    }

    this.setState("disconnected");
  }

  /**
   * Send a JSON message (text frame)
   */
  sendJSON(message: unknown): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /**
   * Send binary data (binary frame)
   */
  sendBinary(data: Uint8Array | ArrayBuffer): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  /**
   * Get the current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === "connected";
  }

  /**
   * Subscribe to state changes
   */
  onStateChange(handler: StateChangeHandler): () => void {
    this.onStateChangeHandlers.add(handler);
    return () => this.onStateChangeHandlers.delete(handler);
  }

  /**
   * Subscribe to errors
   */
  onError(handler: ErrorHandler): () => void {
    this.onErrorHandlers.add(handler);
    return () => this.onErrorHandlers.delete(handler);
  }

  /**
   * Handle binary message - override in subclasses
   */
  protected handleBinaryMessage(data: ArrayBuffer): void {
    // Override in subclasses
    console.log("Received binary message:", data.byteLength, "bytes");
  }

  /**
   * Handle text message - override in subclasses
   */
  protected handleTextMessage(data: string): void {
    // Override in subclasses
    console.log("Received text message:", data);
  }

  /**
   * Handle successful connection - override in subclasses
   */
  protected onConnected(): void {
    // Override in subclasses
  }

  /**
   * Handle disconnection - override in subclasses
   */
  protected onDisconnected(): void {
    // Override in subclasses
  }

  // ===== Private methods =====

  private setupEventListeners(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      console.log(`[WS] Connected successfully`);
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.startHeartbeat();
      this.onConnected();
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Connection closed - code: ${event.code}, reason: "${event.reason}", wasClean: ${event.wasClean}`);
      this.onDisconnected();
      this.stopHeartbeat();

      if (event.wasClean) {
        this.setState("disconnected");
      } else {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      // Note: The browser doesn't expose error details for security reasons
      console.error(`[WS] Error event received (no details available in browser)`);
      this.handleError(new Error("WebSocket error"));
    };

    this.ws.onmessage = (event) => {
      // Route to appropriate handler based on message type
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else if (typeof event.data === "string") {
        this.handleTextMessage(event.data);
      } else if (event.data instanceof Blob) {
        // Convert Blob to ArrayBuffer
        event.data.arrayBuffer().then((buffer) => {
          this.handleBinaryMessage(buffer);
        }).catch((error) => {
          console.error('[WS] Failed to convert Blob to ArrayBuffer:', error);
        });
      }
    };
  }

  private handleError(error: Error): void {
    this.onErrorHandlers.forEach((handler) => handler(error));
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.onStateChangeHandlers.forEach((handler) => handler(state));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.setState("failed");
      return;
    }

    const delay = Math.min(
      this.config.reconnectBaseDelay *
        Math.pow(this.config.reconnectMultiplier, this.reconnectAttempts),
      this.config.reconnectMaxDelay
    );

    this.reconnectAttempts++;
    this.setState("reconnecting");

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.config.heartbeatInterval <= 0) return;

    this.heartbeatTimeout = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send ping as JSON - servers typically respond with pong
        // Override in subclasses if custom heartbeat needed
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimeout) {
      clearInterval(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}
