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
      // Don't log password failures to avoid information disclosure
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
      [UserRole.SUPER_ADMIN]: [UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT, UserRole.SETTLEMENT_ADMIN],
      [UserRole.ADMIN]: [UserRole.AGENT, UserRole.CLIENT],
      [UserRole.AGENT]: [UserRole.CLIENT],
      [UserRole.CLIENT]: [], // Clients cannot create other users
      [UserRole.SETTLEMENT_ADMIN]: [], // Settlement admins cannot create users
    };

    return hierarchy[creatorRole].includes(targetRole);
  }

  // Create user with role hierarchy validation
  async createUser(createUserDto: CreateUserDto, creator: any): Promise<AuthResponseDto> {
    // Removed console.log to avoid exposing user creation details
    
    try {
      const { name, username, email, password, role, balance, initialBalance, commissionPercentage } = createUserDto;
      const resolvedBalance =
        (typeof balance === 'number' ? balance : undefined) ??
        (typeof initialBalance === 'number' ? initialBalance : undefined) ??
        0;

      // Check if creator can create this role
      if (role === UserRole.SUPER_ADMIN) {
        const existingSuperAdmin = await this.usersService.findByRole(UserRole.SUPER_ADMIN);

        // Allow creating first super admin without authentication
        if (!existingSuperAdmin && !creator) {
          // This is allowed - proceed
        } else if (existingSuperAdmin && (!creator || creator.role !== UserRole.SUPER_ADMIN)) {
          throw new ForbiddenException(`Only Super Admins can create users with role: ${role}`);
        }
      } else if (role === UserRole.SETTLEMENT_ADMIN) {
        // SETTLEMENT_ADMIN can only be created by SUPER_ADMIN
        if (!creator) {
          throw new ForbiddenException('Authentication required to create SETTLEMENT_ADMIN users. Use POST /auth/create-user with JWT token.');
        }
        if (creator.role !== UserRole.SUPER_ADMIN) {
          throw new ForbiddenException('Only Super Admins can create SETTLEMENT_ADMIN users');
        }
      } else {
        // For other roles, authentication is required
        if (!creator) {
          throw new ForbiddenException('Authentication required to create users. Use POST /auth/create-user with JWT token.');
        }
        if (!this.canCreateRole(creator.role, role)) {
          throw new ForbiddenException(`You don't have permission to create users with role: ${role}`);
        }
      }

      // Check if username is provided
      if (!username) {
        throw new ConflictException('Username is required');
      }
      
      // Check if user already exists by username
      const existingUserByUsername = await this.usersService.findByUsername(username);
      if (existingUserByUsername) {
        throw new ConflictException('User with this username already exists');
      }
      
      // Check if email is provided and if user exists by email
      if (email) {
        const existingUserByEmail = await this.usersService.findByEmail(email);
        if (existingUserByEmail) {
          throw new ConflictException('User with this email already exists');
        }
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      let user;

      if (role === UserRole.SUPER_ADMIN) {
        // Validate commissionPercentage if provided for SUPER_ADMIN
        if (commissionPercentage !== undefined && commissionPercentage !== null) {
          if (commissionPercentage < 1 || commissionPercentage > 100) {
            throw new BadRequestException('commissionPercentage must be between 1 and 100');
          }
          
          // If creator exists and has commissionPercentage, validate it
          if (creator) {
            const creatorFullData = await this.usersService.findById(creator.id);
            if (creatorFullData && creatorFullData.commissionPercentage !== null) {
              const creatorCommission = creatorFullData.commissionPercentage;
              if (commissionPercentage > creatorCommission) {
                throw new BadRequestException(
                  `Cannot assign commissionPercentage of ${commissionPercentage}%. ` +
                  `Your commissionPercentage is ${creatorCommission}%, so you cannot give more than ${creatorCommission}% to your subordinate. ` +
                  `This would result in a loss for you.`
                );
              }
            }
          }
        }
        
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
      } else if (role === UserRole.SETTLEMENT_ADMIN) {
        // SETTLEMENT_ADMIN: No wallet, no hierarchy, no commission
        user = await this.usersService.create({
          name,
          username,
          email: email || null,
          password: hashedPassword,
          role: UserRole.SETTLEMENT_ADMIN,
          parentId: undefined,
          commissionPercentage: 0,
          // No balance - wallet will not be created
        });
      } else {
        // Create user with hierarchy (set parentId to creator's id)
        // commissionPercentage = percentage THIS USER keeps from downline PnL
        // Parent will get the remaining difference automatically during settlement
        // For Admin: commissionPercentage = % Admin keeps (e.g., 50%)
        // For Agent: commissionPercentage = % Agent keeps (e.g., 70%)
        // For Client: commissionPercentage is not used (always 100% to Agent)
        
        // Only require commissionPercentage for ADMIN and AGENT roles
        if (role === UserRole.ADMIN || role === UserRole.AGENT) {
          if (commissionPercentage === undefined || commissionPercentage === null) {
            throw new BadRequestException('commissionPercentage is required when creating Admin or Agent');
          }
          if (commissionPercentage < 1 || commissionPercentage > 100) {
            throw new BadRequestException('commissionPercentage must be between 1 and 100');
          }
          
          // ✅ Validate that creator's commissionPercentage is not exceeded
          // This prevents loss: if creator has 80%, they can't give more than 80% to subordinate
          if (creator) {
            // Fetch creator's full data to get their commissionPercentage
            const creatorFullData = await this.usersService.findById(creator.id);
            if (creatorFullData && creatorFullData.commissionPercentage !== null) {
              const creatorCommission = creatorFullData.commissionPercentage;
              
              // Subordinate cannot have more commission than creator
              if (commissionPercentage > creatorCommission) {
                throw new BadRequestException(
                  `Cannot assign commissionPercentage of ${commissionPercentage}%. ` +
                  `Your commissionPercentage is ${creatorCommission}%, so you cannot give more than ${creatorCommission}% to your subordinate. ` +
                  `This would result in a loss for you.`
                );
              }
            }
          }
        }
        
        // For CLIENT, commissionPercentage is not used, set to 0 or null
        const finalCommissionPercentage = (role === UserRole.CLIENT) ? 0 : commissionPercentage;
        
        user = await this.usersService.create({
          name,
          username,
          email: email || null,
          password: hashedPassword,
          role,
          parentId: creator.id,
          commissionPercentage: finalCommissionPercentage ?? 0, // Store what THIS USER keeps from downline PnL (0 for CLIENT)
          balance: resolvedBalance, // Pass balance so wallet is created with correct balance
        });
      }

      // User created successfully - removed console.log to avoid exposing user details

      // Generate JWT token with username included
      const payload = { sub: user.id, username: user.username, role: user.role };
      const accessToken = this.jwtService.sign(payload);

      // Fetch the wallet that was created by usersService.create()
      // SETTLEMENT_ADMIN does not have a wallet
      const wallet = user.role === UserRole.SETTLEMENT_ADMIN 
        ? null 
        : await this.prisma.wallet.findUnique({
            where: { userId: user.id },
          });

      return {
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role,
          balance: wallet?.balance ?? (user.role === UserRole.SETTLEMENT_ADMIN ? 0 : resolvedBalance),
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
