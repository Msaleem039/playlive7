import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TransferService {
  constructor(private prisma: PrismaService) {}

  async getUserChildren(userId: string) {
    return this.prisma.user.findMany({
      where: { parentId: userId },
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
      },
    });
  }

  async getHierarchyTree(userId: string) {
    // TODO: Implement hierarchy tree
    return { userId, message: 'Hierarchy tree not yet implemented' };
  }

  async getUserBalance(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, balance: true },
    });
    return user || { id: userId, balance: 0 };
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

  async createUserWithHierarchy(parentId: string, data: {
    name: string;
    username: string;
    password: string;
    role: string;
    commissionPercentage?: number;
    balance?: number;
  }) {
    return this.prisma.user.create({
      data: {
        ...data,
        parentId,
        role: data.role as any,
        commissionPercentage: data.commissionPercentage ?? 100,
        balance: data.balance ?? 0,
      },
    });
  }
}

