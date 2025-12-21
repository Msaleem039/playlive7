# Supabase Connection Troubleshooting

## Current Issue: DNS Resolution Failure

Your connection strings are **correct** (port 6543, Session Pooler), but DNS resolution is failing because ProtonVPN's DNS server cannot resolve `db.isdzyrpqrpmprnxanzdg.supabase.co`.

## Solutions

### Solution 1: Change DNS Server (Recommended)

**Option A: Change System DNS**
1. Open Network Settings
2. Go to your network adapter (or ProtonVPN adapter)
3. Change DNS to:
   - Primary: `8.8.8.8` (Google DNS)
   - Secondary: `1.1.1.1` (Cloudflare DNS)

**Option B: Change ProtonVPN DNS**
1. Open ProtonVPN settings
2. Go to Advanced → DNS
3. Change to Custom DNS: `8.8.8.8` or `1.1.1.1`

### Solution 2: Disable VPN Temporarily

1. Disable ProtonVPN
2. Test connection: `node scripts/test-supabase-connection.js`
3. If it works, the VPN DNS is the issue

### Solution 3: Use IP Address (Not Recommended)

If DNS continues to fail, you can use the IP address directly, but this is not recommended for production.

## Verify Connection

After changing DNS, test:
```bash
node scripts/test-supabase-connection.js
```

## Current Configuration

✅ **Connection Strings:** Correct (port 6543)
✅ **Password:** Correct (no encoding needed)
❌ **DNS Resolution:** Failing (VPN DNS issue)

## Next Steps

1. Change DNS server to 8.8.8.8 or 1.1.1.1
2. Test connection again
3. If still failing, temporarily disable VPN to confirm

