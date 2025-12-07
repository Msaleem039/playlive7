import { Injectable, ConflictException, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UserRole, BetStatus, type User } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const { username, password } = loginDto;

    // Try to find user by username first, then by email
    let user = await this.usersService.findByUsername(username);
    if (!user) {
      // If not found by username, try email
      user = await this.usersService.findByEmail(username);
    }
    
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      console.log('Login failed: Password mismatch');
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate JWT token with username included
    const payload = { sub: user.id, username: user.username, role: user.role };
    const accessToken = this.jwtService.sign(payload);

    // Fetch wallet balance instead of relying on User.balance
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: user.id },
    });

    return {
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        balance: wallet?.balance ?? 0,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      accessToken,
    };
  }

  async changePassword(currentUser: User, changePasswordDto: ChangePasswordDto): Promise<{ message: string }> {
    const { currentPassword, newPassword } = changePasswordDto;

    // Fetch the current user with password from database
    const user = await this.usersService.findById(currentUser.id);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Verify the user's current password
    if (!user.password) {
      throw new UnauthorizedException('User password not found');
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Update user's own password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.usersService.updatePassword(user.id, hashedPassword);

    return { 
      message: 'Password updated successfully' 
    };
  }


  // Role hierarchy validation
  private canCreateRole(creatorRole: UserRole, targetRole: UserRole): boolean {
    const hierarchy: Record<UserRole, UserRole[]> = {
      [UserRole.SUPER_ADMIN]: [UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT],
      [UserRole.ADMIN]: [UserRole.AGENT, UserRole.CLIENT],
      [UserRole.AGENT]: [UserRole.CLIENT],
      [UserRole.CLIENT]: [], // Clients cannot create other users
    };

    return hierarchy[creatorRole].includes(targetRole);
  }

  // Create user with role hierarchy validation
  async createUser(createUserDto: CreateUserDto, creator: any): Promise<AuthResponseDto> {
    console.log('createUser called with:', { createUserDto, creator });
    
    try {
      const { name, username, email, password, role, balance, initialBalance, commissionPercentage } = createUserDto;
      const resolvedBalance =
        (typeof balance === 'number' ? balance : undefined) ??
        (typeof initialBalance === 'number' ? initialBalance : undefined) ??
        0;

      // Check if creator can create this role
      if (role === UserRole.SUPER_ADMIN) {
        console.log('Handling SuperAdmin creation logic');
        const existingSuperAdmin = await this.usersService.findByRole(UserRole.SUPER_ADMIN);

        // Allow creating first super admin without authentication
        if (!existingSuperAdmin && !creator) {
          console.log('Creating first SuperAdmin without authentication');
          // This is allowed - proceed
        } else if (existingSuperAdmin && (!creator || creator.role !== UserRole.SUPER_ADMIN)) {
          console.log('SuperAdmin creation denied:', { creatorRole: creator?.role });
          throw new ForbiddenException(`Only Super Admins can create users with role: ${role}`);
        }
      } else {
        // For non-SUPER_ADMIN roles, authentication is required
        if (!creator) {
          throw new ForbiddenException('Authentication required to create users. Use POST /auth/create-user with JWT token.');
        }
        if (!this.canCreateRole(creator.role, role)) {
          console.log('Role hierarchy check failed:', { creatorRole: creator.role, targetRole: role });
          throw new ForbiddenException(`You don't have permission to create users with role: ${role}`);
        }
      }

      // Check if username is provided
      if (!username) {
        throw new ConflictException('Username is required');
      }
      
      // Check if user already exists by username
      console.log('Checking if user exists with username:', username);
      const existingUserByUsername = await this.usersService.findByUsername(username);
      if (existingUserByUsername) {
        console.log('User already exists with username:', existingUserByUsername);
        throw new ConflictException('User with this username already exists');
      }
      
      // Check if email is provided and if user exists by email
      if (email) {
        const existingUserByEmail = await this.usersService.findByEmail(email);
        if (existingUserByEmail) {
          console.log('User already exists with email:', existingUserByEmail);
          throw new ConflictException('User with this email already exists');
        }
      }

      // Hash password
      console.log('Hashing password...');
      const hashedPassword = await bcrypt.hash(password, 10);

      let user;

      if (role === UserRole.SUPER_ADMIN) {
        console.log('Creating SuperAdmin without hierarchy...');
        user = await this.usersService.create({
          name,
          username,
          email: email || null,
          password: hashedPassword,
          role: UserRole.SUPER_ADMIN,
          parentId: undefined,
          commissionPercentage: commissionPercentage ?? 0,
          balance: resolvedBalance, // Pass balance so wallet is created with correct balance
        });
      } else {
        // Create user with hierarchy (set parentId to creator's id)
        console.log('Creating user with hierarchy...');
        // share (commissionPercentage) is REQUIRED and represents parent's share percentage
        // For Admin: share = SA% (SuperAdmin's share percentage)
        // For Agent: share = AD% (Admin's share percentage)
        // For Client: share is not used (always 100% to Agent)
        if (commissionPercentage === undefined || commissionPercentage === null) {
          throw new BadRequestException('share (commissionPercentage) is required when creating Admin or Agent');
        }
        if (commissionPercentage < 1 || commissionPercentage > 100) {
          throw new BadRequestException('share (commissionPercentage) must be between 1 and 99');
        }
        const share = commissionPercentage;
        user = await this.usersService.create({
          name,
          username,
          email: email || null,
          password: hashedPassword,
          role,
          parentId: creator.id,
          commissionPercentage: share, // Store parent's share % (SA% or AD%) in DB field
          balance: resolvedBalance, // Pass balance so wallet is created with correct balance
        });
      }

      console.log('User created successfully:', user);

      // Generate JWT token with username included
      const payload = { sub: user.id, username: user.username, role: user.role };
      const accessToken = this.jwtService.sign(payload);

      // Fetch the wallet that was created by usersService.create()
      const wallet = await this.prisma.wallet.findUnique({
        where: { userId: user.id },
      });

      return {
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role,
          balance: wallet?.balance ?? resolvedBalance,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        accessToken,
      };
    } catch (error) {
      console.error('Error in createUser:', error);
      throw error;
    }
  }


  async findByRole(role: UserRole) {
    const users = await this.prisma.user.findMany({
      where: { role },
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

  async findByParentAndRole(parentId: string, role: UserRole) {
    const users = await this.prisma.user.findMany({
      where: { parentId, role },
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
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }

  async getSubordinates(userId: string) {
    const users = await this.prisma.user.findMany({
      where: { parentId: userId },
      include: {
        wallet: {
          select: { balance: true, liability: true },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Calculate PL+Cash for each user (balance + profit/loss from settled bets)
    const subordinatesWithFinancials = await Promise.all(
      users.map(async (user) => {
        const balance = user.wallet?.balance ?? 0;
        const liability = user.wallet?.liability ?? 0;

        // Calculate profit/loss from settled bets (WON or LOST)
        const settledBets = await this.prisma.bet.findMany({
          where: {
            userId: user.id,
            status: {
              in: [BetStatus.WON, BetStatus.LOST],
            },
          },
          select: {
            winAmount: true,
            lossAmount: true,
            status: true,
          },
        });

        // Calculate total profit/loss from settled bets
        const profitLoss = settledBets.reduce((total, bet) => {
          if (bet.status === BetStatus.WON) {
            return total + (Number(bet.winAmount) || 0);
          } else {
            return total - (Number(bet.lossAmount) || 0);
          }
        }, 0);

        // PL+Cash = Balance + Profit/Loss from settled bets
        const plCash = balance + profitLoss;

        // Available Balance = Balance - Liability
        const availableBalance = balance - liability;

        return {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role,
          balance: balance,
          liability: liability,
          plCash: plCash,
          availableBalance: availableBalance,
          parentId: user.parentId,
          commissionPercentage: user.commissionPercentage,
          isActive: user.isActive ?? true,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        };
      })
    );

    return subordinatesWithFinancials;
  }

  async toggleUserStatus(currentUser: User, targetUserId: string, isActive: boolean) {
    // Get target user
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      throw new BadRequestException('User not found');
    }

    // Validate that current user is the parent of target user
    if (targetUser.parentId !== currentUser.id) {
      throw new ForbiddenException('You can only change status of your direct subordinates');
    }

    // SuperAdmin can change status of anyone
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      // For other roles, validate hierarchy
      if (currentUser.role === UserRole.ADMIN && targetUser.role !== UserRole.AGENT && targetUser.role !== UserRole.CLIENT) {
        throw new ForbiddenException('Admin can only change status of Agents and Clients');
      }
      if (currentUser.role === UserRole.AGENT && targetUser.role !== UserRole.CLIENT) {
        throw new ForbiddenException('Agent can only change status of Clients');
      }
    }

    // Update user status
    const updatedUser = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: isActive } as any,
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        isActive: true,
        parentId: true,
        commissionPercentage: true,
        createdAt: true,
        updatedAt: true,
      } as any,
    });

    return {
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      user: updatedUser,
    };
  }
}
