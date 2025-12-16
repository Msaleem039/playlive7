# SETTLEMENT_ADMIN Role Implementation

## Overview
A new role `SETTLEMENT_ADMIN` has been created with the following characteristics:

### ✅ Features
- **Zero balance, no wallet**: SETTLEMENT_ADMIN users do not have a wallet created
- **Cannot create or manage users**: SETTLEMENT_ADMIN cannot create any other users
- **Only allowed to settle markets**: Can access all settlement endpoints
- **Created only by SuperAdmin**: Only SUPER_ADMIN can create SETTLEMENT_ADMIN users

---

## Implementation Details

### 1. Database Schema
- Added `SETTLEMENT_ADMIN` to `UserRole` enum in `prisma/schema.prisma`
- Migration file created: `prisma/migrations/20250115120000_add_settlement_admin_role/migration.sql`

### 2. User Creation
- **Location**: `src/users/users.service.ts`
- **Behavior**: Wallet creation is skipped for SETTLEMENT_ADMIN users
- **Code**: 
  ```typescript
  if (user.role !== UserRole.SETTLEMENT_ADMIN) {
    await this.prisma.wallet.create({ ... });
  }
  ```

### 3. Role Hierarchy
- **Location**: `src/auth/auth.service.ts`
- **Can Create**: Only SUPER_ADMIN can create SETTLEMENT_ADMIN users
- **Cannot Create**: SETTLEMENT_ADMIN cannot create any users
- **Special Handling**: SETTLEMENT_ADMIN creation doesn't require commissionPercentage or parentId

### 4. Settlement Access
- **Location**: `src/settlement/settlement-admin.controller.ts`
- **Allowed Roles**: `SUPER_ADMIN`, `ADMIN`, `SETTLEMENT_ADMIN`
- **Endpoints Accessible**:
  - `POST /admin/settlement/fancy` - Manual fancy settlement
  - `POST /admin/settlement/match-odds` - Manual match odds settlement
  - `POST /admin/settlement/bookmaker` - Manual bookmaker settlement
  - `POST /admin/settlement/rollback` - Rollback settlement

### 5. Role Information
- **Location**: `src/auth/auth.controller.ts` - `/auth/roles-info` endpoint
- **Description**: "Settlement administrator - can only settle markets, no wallet, cannot create users"

---

## Usage

### Creating a SETTLEMENT_ADMIN User

**Endpoint**: `POST /auth/create-user`

**Required Headers**:
```
Authorization: Bearer {SUPER_ADMIN_JWT_TOKEN}
```

**Request Body**:
```json
{
  "name": "Settlement Admin",
  "username": "settlement_admin",
  "password": "secure_password",
  "email": "settlement@example.com",
  "role": "SETTLEMENT_ADMIN"
}
```

**Note**: 
- `commissionPercentage` is not required (defaults to 0)
- `balance` or `initialBalance` are ignored (no wallet created)
- Only SUPER_ADMIN can create SETTLEMENT_ADMIN users

**Response**:
```json
{
  "user": {
    "id": "user_id",
    "name": "Settlement Admin",
    "username": "settlement_admin",
    "role": "SETTLEMENT_ADMIN",
    "balance": 0,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T10:00:00.000Z"
  },
  "accessToken": "jwt_token_here"
}
```

---

## Role Comparison

| Feature | SUPER_ADMIN | ADMIN | SETTLEMENT_ADMIN | AGENT | CLIENT |
|---------|-------------|-------|------------------|-------|--------|
| Has Wallet | ✅ | ✅ | ❌ | ✅ | ✅ |
| Can Create Users | ✅ | ✅ | ❌ | ✅ | ❌ |
| Can Settle Markets | ✅ | ✅ | ✅ | ❌ | ❌ |
| Can Manage Balance | ✅ | ✅ | ❌ | ✅ | ❌ |
| Created By | Self (first) | SUPER_ADMIN | SUPER_ADMIN | ADMIN | AGENT |

---

## Migration

To apply the database migration:

```bash
# Run the migration
npx prisma migrate deploy

# Or if using dev environment
npx prisma migrate dev
```

The migration adds `SETTLEMENT_ADMIN` to the `UserRole` enum in PostgreSQL.

---

## TypeScript Note

If you see a TypeScript error about `SETTLEMENT_ADMIN` not existing:
1. The Prisma client has been regenerated (`npx prisma generate`)
2. Restart your TypeScript server in your IDE
3. The error should resolve after the IDE refreshes the types

The code will work correctly at runtime even if the IDE shows the error temporarily.

---

## Testing

To test the SETTLEMENT_ADMIN role:

1. **Create a SETTLEMENT_ADMIN user** (as SUPER_ADMIN):
   ```bash
   POST /auth/create-user
   {
     "name": "Test Settlement Admin",
     "username": "test_settlement",
     "password": "test123",
     "role": "SETTLEMENT_ADMIN"
   }
   ```

2. **Login as SETTLEMENT_ADMIN**:
   ```bash
   POST /auth/login
   {
     "username": "test_settlement",
     "password": "test123"
   }
   ```

3. **Test Settlement Endpoints** (should work):
   ```bash
   POST /admin/settlement/fancy
   Authorization: Bearer {SETTLEMENT_ADMIN_TOKEN}
   ```

4. **Test User Creation** (should fail):
   ```bash
   POST /auth/create-user
   Authorization: Bearer {SETTLEMENT_ADMIN_TOKEN}
   # Should return 403 Forbidden
   ```

5. **Verify No Wallet**:
   ```bash
   GET /users/me/wallet
   Authorization: Bearer {SETTLEMENT_ADMIN_TOKEN}
   # Should return 404 or error (no wallet exists)
   ```

---

## Security Considerations

1. **No Wallet Access**: SETTLEMENT_ADMIN cannot access wallet endpoints
2. **No User Management**: SETTLEMENT_ADMIN cannot create or manage users
3. **Settlement Only**: Limited to settlement operations only
4. **SuperAdmin Control**: Only SUPER_ADMIN can create SETTLEMENT_ADMIN users

This role is designed for users who should only have settlement permissions without any financial or user management capabilities.

