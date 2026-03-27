# realtime-notification-hub

Real-time notification service built on WebSocket with channel-based pub/sub, presence tracking, and delivery guarantees.

## Features

- **Channel Types** — Public, private (auth-gated), and presence (member tracking) channels
- **Presence Tracking** — Know who's online in each channel with `member_joined`/`member_left` events
- **Delivery Guarantees** — Message acknowledgment tracking and buffer for reconnecting clients
- **Heartbeat** — Automatic connection health monitoring with configurable intervals
- **Direct Messaging** — Send notifications to specific users across all their connections
- **Broadcasting** — Global broadcasts or channel-scoped messages

## Quick Start

```typescript
import { createNotificationHub } from 'realtime-notification-hub';

const hub = createNotificationHub({
  port: 8080,
  heartbeatInterval: 30000,
  maxBufferSize: 100,
  authHandler: async (token, channel) => {
    // Validate token for private/presence channels
    return verifyToken(token);
  },
});

hub.start();

// Send to a specific user
hub.sendToUser('user-123', 'order.shipped', { orderId: 'abc' });

// Broadcast to everyone
hub.broadcast('maintenance', { message: 'Server restart in 5 minutes' });
```

## Client Protocol

Connect via WebSocket and send JSON messages:

```json
// Identify yourself
{ "type": "identify", "userId": "user-123", "metadata": { "name": "Marwan" } }

// Subscribe to a channel
{ "type": "subscribe", "channel": "presence-chat-room", "token": "jwt..." }

// Publish to a channel
{ "type": "publish", "channel": "chat-room", "event": "message", "data": { "text": "Hello!" } }

// Acknowledge a message
{ "type": "ack", "messageId": "msg-uuid" }
```

## Channel Naming Convention

| Prefix | Type | Auth Required |
|--------|------|---------------|
| *(none)* | Public | No |
| `private-` | Private | Yes |
| `presence-` | Presence | Yes |

## API

### `createNotificationHub(options?)`

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `8080` | WebSocket server port |
| `heartbeatInterval` | `30000` | Ping interval in ms |
| `heartbeatTimeout` | `10000` | Max time to wait for pong |
| `maxBufferSize` | `100` | Messages buffered per channel |
| `authHandler` | `() => true` | Auth callback for private channels |

### Hub Methods

- `start()` / `stop()` — Lifecycle management
- `broadcast(event, data)` — Send to all connected clients
- `sendToUser(userId, event, data)` — Direct notification
- `broadcastToChannel(channel, payload)` — Channel-scoped broadcast
- `getStats()` — Connected clients, channels, buffered messages
- `getPresenceMembers(channel)` — List users in a presence channel
- `isUserOnline(userId)` — Check if a user has active connections

## License

MIT
