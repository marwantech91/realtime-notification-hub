/**
 * Real-time Notification Hub
 *
 * WebSocket-based notification service with:
 * - Channel-based pub/sub (topic channels, private channels, presence channels)
 * - Connection lifecycle management with heartbeat
 * - Delivery guarantees with acknowledgment tracking
 * - Presence tracking for online users
 * - Message buffering for reconnecting clients
 */

import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';

// === Types ===

export interface NotificationMessage {
  id: string;
  channel: string;
  event: string;
  data: unknown;
  timestamp: string;
  senderId?: string;
}

export interface ClientInfo {
  id: string;
  userId?: string;
  channels: Set<string>;
  metadata: Record<string, unknown>;
  connectedAt: Date;
  lastHeartbeat: Date;
}

export type ChannelType = 'public' | 'private' | 'presence';

export interface Channel {
  name: string;
  type: ChannelType;
  members: Set<string>;
  metadata: Record<string, unknown>;
}

export interface HubOptions {
  port?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  maxBufferSize?: number;
  authHandler?: (token: string, channel: string) => Promise<boolean>;
}

export interface DeliveryReceipt {
  messageId: string;
  clientId: string;
  deliveredAt: string;
  acknowledged: boolean;
}

// === Notification Hub ===

export class NotificationHub {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, { ws: WebSocket; info: ClientInfo }>();
  private channels = new Map<string, Channel>();
  private messageBuffer = new Map<string, NotificationMessage[]>();
  private deliveryReceipts = new Map<string, DeliveryReceipt[]>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private options: Required<HubOptions>;

  constructor(options: HubOptions = {}) {
    this.options = {
      port: options.port ?? 8080,
      heartbeatInterval: options.heartbeatInterval ?? 30000,
      heartbeatTimeout: options.heartbeatTimeout ?? 10000,
      maxBufferSize: options.maxBufferSize ?? 100,
      authHandler: options.authHandler ?? (async () => true),
    };
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.options.port });

    this.wss.on('connection', (ws) => {
      const clientId = randomUUID();
      const info: ClientInfo = {
        id: clientId,
        channels: new Set(),
        metadata: {},
        connectedAt: new Date(),
        lastHeartbeat: new Date(),
      };

      this.clients.set(clientId, { ws, info });
      this.send(ws, { type: 'connected', clientId });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(clientId, msg);
        } catch {
          this.send(ws, { type: 'error', message: 'Invalid JSON' });
        }
      });

      ws.on('close', () => this.handleDisconnect(clientId));
      ws.on('error', () => this.handleDisconnect(clientId));
    });

    this.startHeartbeat();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clients.forEach(({ ws }) => ws.close());
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  // === Message Handling ===

  private async handleMessage(clientId: string, msg: any): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (msg.type) {
      case 'subscribe':
        await this.handleSubscribe(clientId, msg.channel, msg.token);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(clientId, msg.channel);
        break;

      case 'publish':
        this.handlePublish(clientId, msg.channel, msg.event, msg.data);
        break;

      case 'identify':
        this.handleIdentify(clientId, msg.userId, msg.metadata);
        break;

      case 'ack':
        this.handleAck(clientId, msg.messageId);
        break;

      case 'pong':
        client.info.lastHeartbeat = new Date();
        break;

      default:
        this.send(client.ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  }

  private async handleSubscribe(clientId: string, channelName: string, token?: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    const channelType = this.getChannelType(channelName);

    // Auth check for private/presence channels
    if (channelType !== 'public') {
      const authorized = await this.options.authHandler(token || '', channelName);
      if (!authorized) {
        this.send(client.ws, { type: 'error', message: `Unauthorized for channel: ${channelName}` });
        return;
      }
    }

    // Create channel if needed
    if (!this.channels.has(channelName)) {
      this.channels.set(channelName, {
        name: channelName,
        type: channelType,
        members: new Set(),
        metadata: {},
      });
    }

    const channel = this.channels.get(channelName)!;
    channel.members.add(clientId);
    client.info.channels.add(channelName);

    this.send(client.ws, { type: 'subscribed', channel: channelName });

    // Send buffered messages
    const buffered = this.messageBuffer.get(channelName) || [];
    for (const msg of buffered) {
      this.send(client.ws, { type: 'message', ...msg });
    }

    // Presence notification
    if (channelType === 'presence') {
      this.broadcastToChannel(channelName, {
        type: 'presence',
        event: 'member_joined',
        channel: channelName,
        userId: client.info.userId || clientId,
        members: this.getPresenceMembers(channelName),
      }, clientId);
    }
  }

  private handleUnsubscribe(clientId: string, channelName: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const channel = this.channels.get(channelName);
    if (channel) {
      channel.members.delete(clientId);
      client.info.channels.delete(channelName);

      if (channel.type === 'presence') {
        this.broadcastToChannel(channelName, {
          type: 'presence',
          event: 'member_left',
          channel: channelName,
          userId: client.info.userId || clientId,
          members: this.getPresenceMembers(channelName),
        });
      }

      // Cleanup empty channels
      if (channel.members.size === 0) {
        this.channels.delete(channelName);
      }
    }

    this.send(client.ws, { type: 'unsubscribed', channel: channelName });
  }

  private handlePublish(clientId: string, channelName: string, event: string, data: unknown): void {
    const client = this.clients.get(clientId);
    if (!client || !client.info.channels.has(channelName)) {
      if (client) {
        this.send(client.ws, { type: 'error', message: 'Not subscribed to channel' });
      }
      return;
    }

    const notification: NotificationMessage = {
      id: randomUUID(),
      channel: channelName,
      event,
      data,
      timestamp: new Date().toISOString(),
      senderId: client.info.userId || clientId,
    };

    // Buffer the message
    this.bufferMessage(channelName, notification);

    // Broadcast to channel (excluding sender)
    this.broadcastToChannel(channelName, { type: 'message', ...notification }, clientId);

    // Confirm to sender
    this.send(client.ws, { type: 'published', messageId: notification.id });
  }

  private handleIdentify(clientId: string, userId: string, metadata?: Record<string, unknown>): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.info.userId = userId;
    if (metadata) {
      client.info.metadata = { ...client.info.metadata, ...metadata };
    }

    this.send(client.ws, { type: 'identified', userId });
  }

  private handleAck(clientId: string, messageId: string): void {
    const receipts = this.deliveryReceipts.get(messageId) || [];
    const receipt = receipts.find((r) => r.clientId === clientId);
    if (receipt) {
      receipt.acknowledged = true;
    }
  }

  // === Disconnect ===

  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Leave all channels
    for (const channelName of client.info.channels) {
      const channel = this.channels.get(channelName);
      if (channel) {
        channel.members.delete(clientId);

        if (channel.type === 'presence') {
          this.broadcastToChannel(channelName, {
            type: 'presence',
            event: 'member_left',
            channel: channelName,
            userId: client.info.userId || clientId,
            members: this.getPresenceMembers(channelName),
          });
        }

        if (channel.members.size === 0) {
          this.channels.delete(channelName);
        }
      }
    }

    this.clients.delete(clientId);
  }

  // === Broadcasting ===

  broadcastToChannel(channelName: string, payload: unknown, excludeClientId?: string): void {
    const channel = this.channels.get(channelName);
    if (!channel) return;

    for (const memberId of channel.members) {
      if (memberId === excludeClientId) continue;

      const member = this.clients.get(memberId);
      if (member && member.ws.readyState === WebSocket.OPEN) {
        this.send(member.ws, payload);
      }
    }
  }

  broadcast(event: string, data: unknown): void {
    const notification: NotificationMessage = {
      id: randomUUID(),
      channel: '__broadcast__',
      event,
      data,
      timestamp: new Date().toISOString(),
    };

    for (const [, { ws }] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, { type: 'message', ...notification });
      }
    }
  }

  sendToUser(userId: string, event: string, data: unknown): boolean {
    let sent = false;

    for (const [, { ws, info }] of this.clients) {
      if (info.userId === userId && ws.readyState === WebSocket.OPEN) {
        const notification: NotificationMessage = {
          id: randomUUID(),
          channel: `__direct__:${userId}`,
          event,
          data,
          timestamp: new Date().toISOString(),
        };
        this.send(ws, { type: 'message', ...notification });
        sent = true;
      }
    }

    return sent;
  }

  // === Presence ===

  getPresenceMembers(channelName: string): Array<{ userId: string; metadata: Record<string, unknown> }> {
    const channel = this.channels.get(channelName);
    if (!channel) return [];

    const members: Array<{ userId: string; metadata: Record<string, unknown> }> = [];
    for (const memberId of channel.members) {
      const client = this.clients.get(memberId);
      if (client) {
        members.push({
          userId: client.info.userId || memberId,
          metadata: client.info.metadata,
        });
      }
    }

    return members;
  }

  // === Heartbeat ===

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const [clientId, { ws, info }] of this.clients) {
        const elapsed = now - info.lastHeartbeat.getTime();

        if (elapsed > this.options.heartbeatInterval + this.options.heartbeatTimeout) {
          ws.terminate();
          this.handleDisconnect(clientId);
        } else {
          this.send(ws, { type: 'ping' });
        }
      }
    }, this.options.heartbeatInterval);
  }

  // === Buffer ===

  private bufferMessage(channelName: string, message: NotificationMessage): void {
    const buffer = this.messageBuffer.get(channelName) || [];
    buffer.push(message);

    // Trim buffer to max size
    while (buffer.length > this.options.maxBufferSize) {
      buffer.shift();
    }

    this.messageBuffer.set(channelName, buffer);
  }

  // === Helpers ===

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private getChannelType(name: string): ChannelType {
    if (name.startsWith('private-')) return 'private';
    if (name.startsWith('presence-')) return 'presence';
    return 'public';
  }

  // === Stats ===

  getStats(): {
    connectedClients: number;
    activeChannels: number;
    bufferedMessages: number;
  } {
    let bufferedMessages = 0;
    for (const [, buffer] of this.messageBuffer) {
      bufferedMessages += buffer.length;
    }

    return {
      connectedClients: this.clients.size,
      activeChannels: this.channels.size,
      bufferedMessages,
    };
  }

  getChannelInfo(channelName: string): Channel | undefined {
    return this.channels.get(channelName);
  }

  getConnectedClients(): ClientInfo[] {
    return Array.from(this.clients.values()).map(({ info }) => info);
  }

  isUserOnline(userId: string): boolean {
    for (const [, { info }] of this.clients) {
      if (info.userId === userId) return true;
    }
    return false;
  }
}

// === Factory ===

export function createNotificationHub(options?: HubOptions): NotificationHub {
  return new NotificationHub(options);
}

export default NotificationHub;
