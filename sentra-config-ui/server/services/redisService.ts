import Redis from 'ioredis';

interface RedisConnection {
    client: Redis;
    id: string;
    name: string;
    host: string;
    port: number;
}

class RedisService {
    private connections: Map<string, RedisConnection> = new Map();

    async connect(id: string, name: string, host: string, port: number, password?: string): Promise<void> {
        if (this.connections.has(id)) {
            throw new Error('Connection ID already exists');
        }

        const client = new Redis({
            host,
            port,
            password,
            retryStrategy: (times: number) => {
                if (times > 3) {
                    return null; // Stop retrying after 3 attempts
                }
                return Math.min(times * 50, 2000);
            },
            lazyConnect: true // Don't connect immediately on instantiation
        });

        try {
            await client.connect();
            this.connections.set(id, { client, id, name, host, port });
            console.log(`[RedisService] Connected to ${host}:${port} (${id})`);
        } catch (error) {
            console.error(`[RedisService] Failed to connect to ${host}:${port}`, error);
            throw error;
        }
    }

    async disconnect(id: string): Promise<void> {
        const conn = this.connections.get(id);
        if (conn) {
            await conn.client.quit();
            this.connections.delete(id);
            console.log(`[RedisService] Disconnected ${id}`);
        }
    }

    getConnection(id: string): RedisConnection | undefined {
        return this.connections.get(id);
    }

    getAllConnections() {
        return Array.from(this.connections.values()).map(c => ({
            id: c.id,
            name: c.name,
            host: c.host,
            port: c.port
        }));
    }

    async executeCommand(id: string, command: string, args: string[] = []): Promise<any> {
        const conn = this.connections.get(id);
        if (!conn) {
            throw new Error('Connection not found');
        }

        // Safety check: prevent dangerous commands if needed, but for an editor we usually allow most
        // We might want to block 'FLUSHALL' or 'SHUTDOWN' in a production env, but for a dev tool it's usually fine.

        try {
            const result = await conn.client.call(command, ...args);
            return result;
        } catch (error) {
            throw error;
        }
    }
}

export const redisService = new RedisService();
