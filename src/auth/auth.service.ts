import { Injectable, ConflictException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UserRole, type User } from '@prisma/client';
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

    // Find user by username
    const user = await this.usersService.findByUsername(username);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate JWT token
    const payload = { sub: user.id, role: user.role };
    const accessToken = this.jwtService.sign(payload);

    // Fetch wallet balance instead of relying on User.balance
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: user.id },
    });

    return {
      user: {
        id: user.id,
        name: user.name,
        username: (user as any).username,
        role: user.role,
        balance: wallet?.balance ?? 0,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      accessToken,
    };
  }

  async changePassword(userId: string, changePasswordDto: ChangePasswordDto): Promise<{ message: string }> {
    const { currentPassword, newPassword } = changePasswordDto;

    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.usersService.updatePassword(userId, hashedPassword);

    return { message: 'Password updated successfully' };
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
      const { name, username, password, role, balance, initialBalance, commissionPercentage } = createUserDto;
      const resolvedBalance =
        (typeof balance === 'number' ? balance : undefined) ??
        (typeof initialBalance === 'number' ? initialBalance : undefined) ??
        0;

      // Check if creator can create this role
      if (role === UserRole.SUPER_ADMIN) {
        console.log('Handling SuperAdmin creation logic');
        const existingSuperAdmin = await this.usersService.findByRole(UserRole.SUPER_ADMIN);

        if (existingSuperAdmin && creator.role !== UserRole.SUPER_ADMIN) {
          console.log('SuperAdmin creation denied:', { creatorRole: creator.role });
          throw new ForbiddenException(`Only Super Admins can create users with role: ${role}`);
        }
      } else if (!this.canCreateRole(creator.role, role)) {
        console.log('Role hierarchy check failed:', { creatorRole: creator.role, targetRole: role });
        throw new ForbiddenException(`You don't have permission to create users with role: ${role}`);
      }

      // Check if user already exists
      console.log('Checking if user exists with username:', username);
      const existingUser = await this.usersService.findByUsername(username);
      if (existingUser) {
        console.log('User already exists:', existingUser);
        throw new ConflictException('User with this username already exists');
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
          password: hashedPassword,
          role: UserRole.SUPER_ADMIN,
          parentId: undefined,
          commissionPercentage: commissionPercentage ?? 0,
        });
      } else {
        // Create user with hierarchy (set parentId to creator's id)
        console.log('Creating user with hierarchy...');
        user = await this.usersService.create({
          name,
          username,
          password: hashedPassword,
          role,
          parentId: creator.id,
          commissionPercentage: commissionPercentage ?? 100,
        });
      }

      console.log('User created successfully:', user);

      // Create initial wallet with resolved balance
      await this.prisma.wallet.create({
        data: {
          userId: user.id,
          balance: resolvedBalance,
          liability: 0,
        },
      });

      // Generate JWT token
      const payload = { sub: user.id, role: user.role };
      const accessToken = this.jwtService.sign(payload);

      const wallet = await this.prisma.wallet.findUnique({
        where: { userId: user.id },
      });

      return {
        user: {
          id: user.id,
          name: user.name,
          username: (user as any).username,
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
      username: (user as any).username,
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
      username: (user as any).username,
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
          select: { balance: true },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      username: (user as any).username,
      role: user.role,
      balance: user.wallet?.balance ?? 0,
      parentId: user.parentId,
      commissionPercentage: user.commissionPercentage,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }
}
