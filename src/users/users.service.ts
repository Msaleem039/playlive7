import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, UserRole, BetStatus } from '@prisma/client';
import { UserResponseDto } from '../auth/dto/auth-response.dto';

type UserDetail = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  balance: number;
  parentId: string | null;
  commissionPercentage: number;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    try {
      return await this.prisma.user.findUnique({
        where: { id },
      });
    } catch (error) {
      // Handle database connection errors gracefully in development
      if (error instanceof Error && error.message.includes("Can't reach database")) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('Database not available - returning null (development mode)');
          return null;
        }
      }
      throw error;
    }
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { username },
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { email },
    });
  }

  async findByRole(role: UserRole): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { role },
    });
  }

  async create(data: {
    name: string;
    username: string;
    email?: string | null;
    password: string;
    role?: UserRole;
    balance?: number;
    parentId?: string;
    commissionPercentage?: number;
  }): Promise<User> {
    const { balance, ...userData } = data;

    const user = await this.prisma.user.create({
      data: {
        ...userData,
        email: userData.email ?? null,
        role: userData.role ?? UserRole.CLIENT,
        commissionPercentage: userData.commissionPercentage ?? 100,
      },
    });

    // SETTLEMENT_ADMIN should not have a wallet (zero balance, no wallet)
    if (user.role !== UserRole.SETTLEMENT_ADMIN) {
      await this.prisma.wallet.create({
        data: {
          userId: user.id,
          balance: balance ?? 0,
          liability: 0,
        },
      });
    }

    return user;
  }

  async updateRole(id: string, role: UserRole): Promise<UserResponseDto> {
    const user = await this.prisma.user.update({
      where: { id },
      data: { role },
      include: {
        wallet: {
          select: { balance: true },
        },
      },
    });

    return {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      balance: user.wallet?.balance ?? 0,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async updatePassword(id: string, password: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { password },
    });
  }

  async updateCommission(id: string, commissionPercentage: number): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { commissionPercentage },
    });
  }

  async getCurrentUser(id: string): Promise<UserResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        wallet: {
          select: { balance: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      balance: user.wallet?.balance ?? 0,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async getUserDetail(id: string): Promise<UserDetail | null> {
    const result = await this.prisma.user.findUnique({
      where: { id },
      include: {
        wallet: {
          select: { balance: true },
        },
      },
    });

    if (!result) return null;

    return {
      id: result.id,
      name: result.name,
      username: result.username,
      role: result.role,
      balance: result.wallet?.balance ?? 0,
      parentId: result.parentId,
      commissionPercentage: result.commissionPercentage,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }

  async getAllUsers(): Promise<UserResponseDto[]> {
    const users = await this.prisma.user.findMany({
      include: {
        wallet: {
          select: { balance: true },
        },
      },
    });

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      balance: user.wallet?.balance ?? 0,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }

  async getWalletBalanceWithLiability(userId: string) {
    // OPTIMIZED: Parallel fetch wallet and liability calculation
    const [wallet, liability] = await Promise.all([
      this.prisma.wallet.findUnique({
        where: { userId },
        select: {
          balance: true,
          liability: true,
        },
      }),
      this.prisma.bet.aggregate({
        where: {
          userId,
          status: BetStatus.PENDING,
        },
        _sum: {
          lossAmount: true,
        },
      }),
    ]);

    if (!wallet) {
      throw new NotFoundException('Wallet not found for user');
    }

    // Use wallet.liability as single source of truth (already calculated and maintained)
    const lockedLiability = wallet.liability ?? 0;

    return {
      balance: wallet.balance,
      liability: lockedLiability,
      availableBalance: wallet.balance,
    };
  }
}
