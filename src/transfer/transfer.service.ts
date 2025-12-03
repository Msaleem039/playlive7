import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class TransferService {
  constructor(private prisma: PrismaService) {}

  async getUserChildren(userId: string) {
    const users = await this.prisma.user.findMany({
      where: { parentId: userId },
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
      parentId: user.parentId,
      commissionPercentage: user.commissionPercentage,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }

  async getHierarchyTree(userId: string) {
    // TODO: Implement hierarchy tree
    return { userId, message: 'Hierarchy tree not yet implemented' };
  }

  async getUserBalance(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });
    return { id: userId, balance: wallet?.balance ?? 0 };
  }

  async getTransferHistory(userId: string, limit?: number) {
    // TODO: Implement transfer history
    return [];
  }

  async transferFunds(fromUserId: string, dto: { toUserId: string; amount: number }) {
    // TODO: Implement fund transfer
    return { fromUserId, ...dto, message: 'Transfer not yet implemented' };
  }

  async updateCommissionPercentage(parentId: string, childId: string, commissionPercentage: number) {
    return this.prisma.user.update({
      where: { id: childId },
      data: { commissionPercentage },
    });
  }

  async createUserWithHierarchy(
    parentId: string,
    data: {
      name: string;
      username: string;
      password: string;
      role: string;
      commissionPercentage?: number;
      balance?: number;
    },
  ) {
    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await this.prisma.user.create({
      data: {
        ...data,
        password: hashedPassword,
        parentId,
        role: data.role as any,
        commissionPercentage: data.commissionPercentage ?? 100,
      },
    });

    await this.prisma.wallet.create({
      data: {
        userId: user.id,
        balance: data.balance ?? 0,
        liability: 0,
      },
    });

    return user;
  }
}

