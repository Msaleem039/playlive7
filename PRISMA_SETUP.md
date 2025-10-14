# Prisma Setup for Neon Database

This project has been configured to use Prisma ORM with Neon database instead of TypeORM.

## Environment Setup

1. Copy the environment file:
   ```bash
   cp env.neon.example .env
   ```

2. Update the `.env` file with your Neon database credentials:
   ```env
   DATABASE_URL="postgresql://username:password@your-neon-host.neon.tech/your-database?sslmode=require"
   DIRECT_URL="postgresql://username:password@your-neon-host.neon.tech/your-database?sslmode=require"
   ```

## Database Commands

- **Generate Prisma Client**: `npm run prisma:generate`
- **Create Migration**: `npm run prisma:migrate`
- **Deploy Migrations**: `npm run prisma:deploy`
- **Open Prisma Studio**: `npm run prisma:studio`
- **Reset Database**: `npm run prisma:reset`

## First Time Setup

1. Generate the Prisma client:
   ```bash
   npm run prisma:generate
   ```

2. Create and apply your first migration:
   ```bash
   npm run prisma:migrate
   ```

3. (Optional) Open Prisma Studio to view your data:
   ```bash
   npm run prisma:studio
   ```

## Using Prisma in Services

The `PrismaService` is globally available and can be injected into any service:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../config/prisma.service';

@Injectable()
export class YourService {
  constructor(private prisma: PrismaService) {}

  async getUsers() {
    return this.prisma.user.findMany();
  }
}
```

## Schema Models

The following models are available:
- `User` - User accounts
- `Wallet` - User wallets
- `Match` - Sports matches
- `Bet` - User bets
- `Transaction` - Wallet transactions

See `prisma/schema.prisma` for the complete schema definition.
