import { Injectable, ConflictException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { TransferService } from '../transfer/transfer.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private transferService: TransferService,
  ) {}

  async register(registerDto: RegisterDto): Promise<AuthResponseDto> {
    const { name, email, password, role = UserRole.CLIENT, balance, initialBalance } = registerDto;
    const resolvedBalance = (typeof balance === 'number' ? balance : undefined) ?? (typeof initialBalance === 'number' ? initialBalance : undefined) ?? 0;

    // Check if user already exists
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await this.usersService.create({
      name,
      email,
      password: hashedPassword,
      role,
      balance: resolvedBalance,
    });

    // Generate JWT token
    const payload = { sub: user.id, role: user.role };
    const accessToken = this.jwtService.sign(payload);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        balance: user.balance,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      accessToken,
    };
  }

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const { email, password } = loginDto;

    // Find user by email
    const user = await this.usersService.findByEmail(email);
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

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        balance: user.balance,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      accessToken,
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
      const { name, email, password, role, balance, initialBalance, commissionPercentage } = createUserDto;
      const resolvedBalance = (typeof balance === 'number' ? balance : undefined) ?? (typeof initialBalance === 'number' ? initialBalance : undefined) ?? 0;

      // Check if creator can create this role
      if (!this.canCreateRole(creator.role, role)) {
        console.log('Role hierarchy check failed:', { creatorRole: creator.role, targetRole: role });
        throw new ForbiddenException(`You don't have permission to create users with role: ${role}`);
      }

      // Check if user already exists
      console.log('Checking if user exists with email:', email);
      const existingUser = await this.usersService.findByEmail(email);
      if (existingUser) {
        console.log('User already exists:', existingUser);
        throw new ConflictException('User with this email already exists');
      }

      // Hash password
      console.log('Hashing password...');
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user with hierarchy using TransferService
      console.log('Creating user with hierarchy...');
      const user = await this.transferService.createUserWithHierarchy(creator.id, {
        name,
        email,
        password: hashedPassword,
        role,
        commissionPercentage,
        balance: resolvedBalance
      });

      console.log('User created successfully:', user);

      // Generate JWT token
      const payload = { sub: user.id, role: user.role };
      const accessToken = this.jwtService.sign(payload);

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          balance: user.balance,
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

  /**
   * Create initial SuperAdmin (public endpoint for setup)
   * Only works if no SuperAdmin exists in the system
   */
  async createSuperAdmin(createUserDto: CreateUserDto): Promise<AuthResponseDto> {
    const { name, email, password } = createUserDto;

    // Check if any SuperAdmin already exists
    const existingSuperAdmin = await this.usersService.findByRole(UserRole.SUPER_ADMIN);
    if (existingSuperAdmin) {
      throw new ForbiddenException('SuperAdmin already exists. Use create-additional-superadmin endpoint instead.');
    }

    // Check if user already exists
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create SuperAdmin with no parent
    const user = await this.usersService.create({
      name,
      email,
      password: hashedPassword,
      role: UserRole.SUPER_ADMIN,
      balance: 0,
      parentId: undefined,
      commissionPercentage: 0 // SuperAdmin has no commission
    });

    // Generate JWT token
    const payload = { sub: user.id, role: user.role };
    const accessToken = this.jwtService.sign(payload);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        balance: user.balance,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      accessToken,
    };
  }

}
