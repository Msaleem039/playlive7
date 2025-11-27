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
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { username },
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
    password: string;
    role?: UserRole;
    balance?: number;
    parentId?: string;
    commissionPercentage?: number;
  }): Promise<User> {
    return this.prisma.user.create({
      data,
    });
  }

  async updateRole(id: string, role: UserRole): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { role },
    });
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
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        balance: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async getUserDetail(id: string): Promise<UserDetail | null> {
    const result = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        balance: true,
        parentId: true,
        commissionPercentage: true,
        createdAt: true,
        updatedAt: true,
      } as any,
    });

    return result as UserDetail | null;
  }

  async getAllUsers(): Promise<UserResponseDto[]> {
    return this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        balance: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async getWalletBalanceWithLiability(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found for user');
    }

    const liability = await this.prisma.bet.aggregate({
      where: {
        userId,
        status: BetStatus.PENDING,
      },
      _sum: {
        lossAmount: true,
      },
    });

    return {
      balance: wallet.balance,
      liability: liability._sum.lossAmount ?? 0,
      availableBalance: wallet.balance - (liability._sum.lossAmount ?? 0),
    };
  }
}
