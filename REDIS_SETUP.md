# Redis Setup Instructions

## Installation

Install ioredis package:

```bash
npm install ioredis
npm install --save-dev @types/ioredis
```

## Environment Configuration

Add Redis URL to your `.env` file:

```env
REDIS_URL=redis://localhost:6379
# Or for production:
# REDIS_URL=redis://your-redis-host:6379
# REDIS_URL=rediss://your-redis-host:6380  # For SSL
```

## Redis Server

### Local Development
Install and run Redis locally:
- **Windows**: Download from https://github.com/microsoftarchive/redis/releases
- **macOS**: `brew install redis && brew services start redis`
- **Linux**: `sudo apt-get install redis-server && sudo systemctl start redis`

### Production
Use a managed Redis service:
- AWS ElastiCache
- Redis Cloud
- Azure Cache for Redis
- DigitalOcean Managed Redis

## Verification

After setup, the application will:
1. Connect to Redis on startup
2. Log "Redis client ready" when connected
3. Fall back gracefully if Redis is unavailable (continues without cache)

## Performance Impact

- **Vendor API calls**: Cached in Redis (3-10 second TTL)
- **Position calculations**: Snapshots stored in Redis
- **Exposure calculations**: Snapshots stored in Redis
- **PnL data**: Snapshots stored in Redis

Expected improvements:
- User API response time: **60-80% faster**
- Vendor API latency: **Removed from user requests** (handled by background cron)
- Database queries: **10-20% faster** (already well-indexed)




