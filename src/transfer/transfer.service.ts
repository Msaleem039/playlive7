import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole, TransferStatus } from '@prisma/client';
import type { User } from '@prisma/client';

export interface TransferDto {
  toUserId: string;
  amount: number;
}

export interface TransferResult {
  id: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  commissionPercentage: number;
  finalAmount: number;
  commissionAmount: number;
  status: TransferStatus;
  createdAt: Date;
}

@Injectable()
export class TransferService {
  constructor(private prisma: PrismaService) {}

  // Role hierarchy mapping
  private readonly roleHierarchy: Record<UserRole, UserRole[]> = {
    [UserRole.SUPER_ADMIN]: [UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT],
    [UserRole.ADMIN]: [UserRole.AGENT, UserRole.CLIENT],
    [UserRole.AGENT]: [UserRole.CLIENT],
    [UserRole.CLIENT]: []
  };

  // Dynamic commission management
  async getDefaultCommission(parentRole: UserRole): Promise<number> {
    // You can make this configurable via database or environment variables
    const defaultCommissions = {
      [UserRole.SUPER_ADMIN]: 10, // 10% commission when creating Admin
      [UserRole.ADMIN]: 20,       // 20% commission when creating Agent
      [UserRole.AGENT]: 100       // 100% commission when creating Client (default)
    };
    
    return defaultCommissions[parentRole] || 100;
  }

  async setDefaultCommission(parentRole: UserRole, commissionPercentage: number): Promise<void> {
    // This could be stored in a configuration table in the future
    // For now, we'll use the existing logic
    if (commissionPercentage < 0 || commissionPercentage > 100) {
      throw new BadRequestException('Commission percentage must be between 0 and 100');
    }
    
    // You can implement database storage for default commissions here
    // For now, we'll just validate and return
  }

  /**
   * Check if a user can create another user with a specific role
   */
  canCreateRole(creatorRole: UserRole, targetRole: UserRole): boolean {
    return this.roleHierarchy[creatorRole].includes(targetRole);
  }

  /**
   * Check if a user can transfer funds to another user (parent-child relationship)
   */
  async canTransferTo(fromUserId: string, toUserId: string): Promise<boolean> {
    const fromUser = await this.prisma.user.findUnique({
      where: { id: fromUserId },
      include: { children: true }
    });

    if (!fromUser) {
      throw new NotFoundException('Sender user not found');
    }

    // Check if toUserId is a direct child of fromUserId
    return fromUser.children.some(child => child.id === toUserId);
  }

  /**
   * Transfer funds from parent to child with commission
   */
  async transferFunds(fromUserId: string, transferDto: TransferDto): Promise<TransferResult> {
    const { toUserId, amount } = transferDto;

    // Validate amount
    if (amount <= 0) {
      throw new BadRequestException('Transfer amount must be greater than 0');
    }

    // Get sender user with balance
    const fromUser = await this.prisma.user.findUnique({
      where: { id: fromUserId },
      include: { children: true }
    });

    if (!fromUser) {
      throw new NotFoundException('Sender user not found');
    }

    // Get receiver user
    const toUser = await this.prisma.user.findUnique({
      where: { id: toUserId }
    });

    if (!toUser) {
      throw new NotFoundException('Receiver user not found');
    }

    // Check if sender has sufficient balance
    if (fromUser.balance < amount) {
      throw new BadRequestException('Insufficient balance');
    }

    // Check if receiver is a direct child of sender
    const isDirectChild = fromUser.children.some(child => child.id === toUserId);
    if (!isDirectChild) {
      throw new ForbiddenException('You can only transfer funds to your direct children');
    }

    // Calculate commission and final amount
    const commissionPercentage = toUser.commissionPercentage;
    const finalAmount = (amount * commissionPercentage) / 100;
    const commissionAmount = amount - finalAmount;

    // Perform the transfer in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Update sender balance
      await tx.user.update({
        where: { id: fromUserId },
        data: { balance: fromUser.balance - amount }
      });

      // Update receiver balance
      await tx.user.update({
        where: { id: toUserId },
        data: { balance: toUser.balance + finalAmount }
      });

      // Create transfer transaction record
      const transferTransaction = await tx.transferTransaction.create({
        data: {
          fromUserId,
          toUserId,
          amount,
          commissionPercentage,
          finalAmount,
          commissionAmount,
          status: TransferStatus.COMPLETED
        }
      });

      return transferTransaction;
    });

    return {
      id: result.id,
      fromUserId: result.fromUserId,
      toUserId: result.toUserId,
      amount: result.amount,
      commissionPercentage: result.commissionPercentage,
      finalAmount: result.finalAmount,
      commissionAmount: result.commissionAmount,
      status: result.status,
      createdAt: result.createdAt
    };
  }

  /**
   * Get user's balance
   */
  async getUserBalance(userId: string): Promise<{ balance: number; user: User }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      balance: user.balance,
      user
    };
  }

  /**
   * Get user's children (for hierarchy management)
   */
  async getUserChildren(userId: string): Promise<User[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { children: true }
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user.children;
  }

  /**
   * Get transfer history for a user
   */
  async getTransferHistory(userId: string, limit: number = 50): Promise<any[]> {
    return this.prisma.transferTransaction.findMany({
      where: {
        OR: [
          { fromUserId: userId },
          { toUserId: userId }
        ]
      },
      include: {
        fromUser: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true
          }
        },
        toUser: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
  }

  /**
   * Create a user with proper parent-child relationship and commission
   */
  async createUserWithHierarchy(
    creatorId: string,
    userData: {
      name: string;
      email: string;
      password: string;
      role: UserRole;
      commissionPercentage?: number;
      balance?: number;
    }
  ): Promise<User> {
    const creator = await this.prisma.user.findUnique({
      where: { id: creatorId }
    });

    if (!creator) {
      throw new NotFoundException('Creator user not found');
    }

    // Check if creator can create this role
    if (!this.canCreateRole(creator.role, userData.role)) {
      throw new ForbiddenException(`You don't have permission to create users with role: ${userData.role}`);
    }

    // Set default commission percentage if not provided
    const commissionPercentage = userData.commissionPercentage || await this.getDefaultCommission(creator.role);

    // Create user with parent relationship
    return this.prisma.user.create({
      data: {
        ...userData,
        parentId: creatorId,
        commissionPercentage,
        // Ensure balance is set if provided, otherwise default to Prisma default
        ...(typeof userData.balance === 'number' ? { balance: userData.balance } : {})
      }
    });
  }

  /**
   * Get hierarchy tree for a user
   */
  async getHierarchyTree(userId: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        children: {
          include: {
            children: {
              include: {
                children: true
              }
            }
          }
        },
        parent: {
          include: {
            parent: true
          }
        }
      }
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  /**
   * Update user's commission percentage (only by parent)
   */
  async updateCommissionPercentage(
    parentId: string,
    childId: string,
    newPercentage: number
  ): Promise<User> {
    if (newPercentage < 0 || newPercentage > 100) {
      throw new BadRequestException('Commission percentage must be between 0 and 100');
    }

    const parent = await this.prisma.user.findUnique({
      where: { id: parentId },
      include: { children: true }
    });

    if (!parent) {
      throw new NotFoundException('Parent user not found');
    }

    const isDirectChild = parent.children.some(child => child.id === childId);
    if (!isDirectChild) {
      throw new ForbiddenException('You can only update commission for your direct children');
    }

    return this.prisma.user.update({
      where: { id: childId },
      data: { commissionPercentage: newPercentage }
    });
  }
}
