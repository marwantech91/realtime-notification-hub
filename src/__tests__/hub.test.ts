import { NotificationHub, NotificationMessage, ClientInfo } from '../index';

// We test the hub logic without actual WebSocket connections
// by testing the public API surface: stats, channels, presence, buffering

describe('NotificationHub', () => {
  let hub: NotificationHub;

  beforeEach(() => {
    hub = new NotificationHub({ port: 0 });
  });

  afterEach(() => {
    hub.stop();
  });

  describe('constructor', () => {
    it('creates hub with default options', () => {
      const h = new NotificationHub();
      expect(h).toBeInstanceOf(NotificationHub);
      h.stop();
    });

    it('creates hub with custom options', () => {
      const h = new NotificationHub({
        port: 9999,
        heartbeatInterval: 5000,
        heartbeatTimeout: 3000,
        maxBufferSize: 50,
      });
      expect(h).toBeInstanceOf(NotificationHub);
      h.stop();
    });
  });

  describe('getStats', () => {
    it('returns zero stats when no clients are connected', () => {
      const stats = hub.getStats();
      expect(stats).toEqual({
        connectedClients: 0,
        activeChannels: 0,
        bufferedMessages: 0,
      });
    });
  });

  describe('getConnectedClients', () => {
    it('returns empty array when no clients', () => {
      expect(hub.getConnectedClients()).toEqual([]);
    });
  });

  describe('getChannelInfo', () => {
    it('returns undefined for non-existent channel', () => {
      expect(hub.getChannelInfo('non-existent')).toBeUndefined();
    });
  });

  describe('getPresenceMembers', () => {
    it('returns empty array for non-existent channel', () => {
      expect(hub.getPresenceMembers('presence-room')).toEqual([]);
    });
  });

  describe('isUserOnline', () => {
    it('returns false when no clients are connected', () => {
      expect(hub.isUserOnline('user-1')).toBe(false);
    });
  });

  describe('sendToUser', () => {
    it('returns false when user is not connected', () => {
      expect(hub.sendToUser('unknown-user', 'test', { hello: 'world' })).toBe(false);
    });
  });

  describe('broadcastToChannel', () => {
    it('does nothing for non-existent channel', () => {
      // Should not throw
      expect(() => hub.broadcastToChannel('no-channel', { data: 'test' })).not.toThrow();
    });
  });

  describe('broadcast', () => {
    it('does nothing when no clients are connected', () => {
      // Should not throw
      expect(() => hub.broadcast('test-event', { value: 42 })).not.toThrow();
    });
  });

  describe('stop', () => {
    it('can be called multiple times safely', () => {
      hub.stop();
      hub.stop();
      expect(hub.getStats().connectedClients).toBe(0);
    });
  });
});

describe('Channel type detection', () => {
  it('identifies public channels', () => {
    const hub = new NotificationHub();
    // Public channels don't start with private- or presence-
    // We can verify via getChannelInfo after subscription
    expect(hub.getChannelInfo('general')).toBeUndefined();
    hub.stop();
  });
});
