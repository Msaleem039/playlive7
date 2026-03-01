import { Injectable, ConflictException, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStatementService, AccountStatementFilters } from '../roles/account-statement.service';
import { SettlementService } from '../settlement/settlement.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { UserRole, BetStatus, TransferLogType, type User } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private prisma: PrismaService,
    private accountStatementService: AccountStatementService,
    private settlementService: SettlementService,
  ) {}

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const { username, password } = loginDto;

    // ✅ Case-insensitive username/email lookup
    // Try to find user by username first (case-insensitive), then by email
    let user = await this.prisma.user.findFirst({
      where: {
        username: {
          equals: username,
          mode: 'insensitive', // Case-insensitive search
        },
      },
    });
    
    if (!user) {
      // If not found by username, try email (case-insensitive)
      user = await this.prisma.user.findFirst({
        where: {
          email: {
            equals: username,
            mode: 'insensitive', // Case-insensitive search
          },
        },
      });
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

  async changePassword(
    currentUser: User,
    changePasswordDto: ChangePasswordDto
  ): Promise<{ message: string }> {
    const { password, confirmPassword } = changePasswordDto;
  
    // 1️⃣ Check password match
    if (password !== confirmPassword) {
      throw new BadRequestException('Password and confirm password do not match');
    }
  
    // 2️⃣ Fetch logged-in user from token
    const user = await this.usersService.findById(currentUser.id);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
  
    // 3️⃣ Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);
  
    // 4️⃣ Update password
    await this.usersService.updatePassword(user.id, hashedPassword);
  
    return {
      message: 'Password updated successfully',
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
      
      // ✅ Case-insensitive username check: prevent "John" and "john" from both existing
      const existingUserByUsername = await this.prisma.user.findFirst({
        where: {
          username: {
            equals: username,
            mode: 'insensitive', // Case-insensitive search
          },
        },
      });
      if (existingUserByUsername) {
        throw new ConflictException('User with this username already exists (case-insensitive check)');
      }
      
      // Check if email is provided and if user exists by email (case-insensitive)
      if (email) {
        const existingUserByEmail = await this.prisma.user.findFirst({
          where: {
            email: {
              equals: email,
              mode: 'insensitive', // Case-insensitive search
            },
          },
        });
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

  /**
   * Get subordinates with financial information
   * 
   * Enhanced to support hierarchical drill-down:
   * - Default: Returns direct subordinates of current user
   * - With parentId: Returns children of specified parent (with access validation)
   * - With parentId + type=bets: Returns bet history for CLIENT
   * - With type=statement: Returns subordinates with account statement details
   * 
   * BETFAIR STANDARD: Uses userPnl as single source of truth for P/L
   * 
   * CRITICAL:
   * - wallet.balance already includes settled P/L (updated at settlement)
   * - Never add profitLoss to balance (would double-count)
   * - profitLoss is for reporting only
   * - plCash = balance (balance already includes P/L)
   * 
   * Validation check:
   * balance_after_settlement === opening_balance + deposits - withdrawals + total_net_pnl
   */
  async getSubordinates(
    currentUser: User,
    parentId?: string,
    type?: string,
    statementFilters?: AccountStatementFilters,
  ) {
    // 🔐 ACCESS VALIDATION: CLIENT role cannot access this endpoint
    if (currentUser.role === UserRole.CLIENT) {
      throw new ForbiddenException('Clients are not allowed to access this endpoint');
    }

    // If type=bets and parentId provided, return bet history
    if (type === 'bets' && parentId) {
      return this.getClientBetHistory(currentUser, parentId);
    }

    // Determine target parentId (default to current user if not provided)
    let targetParentId = currentUser.id;

    // If parentId is provided, validate access and resolve to actual user ID
    if (parentId) {
      targetParentId = await this.validateHierarchyAccess(currentUser, parentId);
    }

    // Get children of target parent
    const users = await this.prisma.user.findMany({
      where: { parentId: targetParentId },
      include: {
        wallet: {
          select: {
            balance: true,
            liability: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const userIds = users.map((u) => u.id);

    // 🔹 Fetch settled PnL from userPnl table (single source of truth)
    // Uses userPnl which aggregates bet.pnl values from settlement
    // @ts-ignore - userPnl property exists after Prisma client regeneration
    const pnls = await this.prisma.userPnl.findMany({
      where: {
        userId: { in: userIds },
      },
      select: {
        userId: true,
        netPnl: true,
      },
    });

    // Create map for quick lookup
    const pnlMap = pnls.reduce(
      (acc, p) => {
        acc[p.userId] = (acc[p.userId] || 0) + p.netPnl;
        return acc;
      },
      {} as Record<string, number>,
    );

    // If type=statement and showCashEntry=true, fetch transfer transactions
    const includeTransactions = type === 'statement' && statementFilters?.showCashEntry !== false;

    // Fetch transfer logs for all users in parallel if needed
    const transferLogsMap = new Map<string, any[]>();
    if (includeTransactions) {
      const transferLogsPromises = users.map(async (user) => {
        try {
          // Get transfer logs between user and their parent (or current user as parent)
          const parentIdForTransfers = user.parentId || targetParentId;
          
          const logs = await this.prisma.transferLog.findMany({
            where: {
              OR: [
                { fromUserId: parentIdForTransfers, toUserId: user.id, type: TransferLogType.TOPUP },
                { fromUserId: user.id, toUserId: parentIdForTransfers, type: TransferLogType.TOPDOWN },
              ],
              ...(statementFilters?.fromDate || statementFilters?.toDate
                ? {
                    createdAt: {
                      ...(statementFilters.fromDate ? { gte: statementFilters.fromDate } : {}),
                      ...(statementFilters.toDate ? { lte: statementFilters.toDate } : {}),
                    },
                  }
                : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: statementFilters?.limit || 1000,
            skip: statementFilters?.offset || 0,
          });

          return { userId: user.id, logs };
        } catch (error) {
          console.error(`Failed to get transfer logs for user ${user.id}:`, error);
          return { userId: user.id, logs: [] };
        }
      });

      const transferLogsResults = await Promise.all(transferLogsPromises);
      for (const result of transferLogsResults) {
        transferLogsMap.set(result.userId, result.logs);
      }
    }

    // If type=statement, fetch bet history for each client (high limit to build statement from all settled bets)
    const betHistoryMap = new Map<string, any>();
    if (type === 'statement' && statementFilters) {
      const betFetchLimit = Math.min(statementFilters.limit ? statementFilters.limit * 50 : 10000, 10000);
      const betHistoryPromises = users
        .filter(user => user.role === UserRole.CLIENT)
        .map(async (user) => {
          try {
            const betHistory = await this.settlementService.getUserBetHistory({
              userId: user.id,
              status: statementFilters.betStatus,
              limit: betFetchLimit,
              offset: 0,
              startDate: statementFilters.fromDate ?? statementFilters.betStartDate,
              endDate: statementFilters.toDate ?? statementFilters.betEndDate,
            });
            return { userId: user.id, betHistory };
          } catch (error) {
            console.error(`Failed to get bet history for user ${user.id}:`, error);
            return { userId: user.id, betHistory: { success: true, data: [], count: 0, total: 0, limit: betFetchLimit, offset: 0, hasMore: false } };
          }
        });

      const betHistoryResults = await Promise.all(betHistoryPromises);
      for (const result of betHistoryResults) {
        betHistoryMap.set(result.userId, result.betHistory);
      }
    }

    // When type=statement, return new statement shape per subordinate
    if (type === 'statement') {
      const limit = statementFilters?.limit ?? 1000;
      const offset = statementFilters?.offset ?? 0;

      return users.map((user) => {
        const balance = user.wallet?.balance ?? 0;
        const betHistory = betHistoryMap.get(user.id);
        const bets: any[] = (betHistory?.data ?? []) as any[];

        // Group bets by marketId + selectionId
        const groupKey = (b: any) => `${b.marketId ?? ''}|${b.selectionId ?? ''}`;
        const groups = new Map<string, any[]>();
        for (const b of bets) {
          const key = groupKey(b);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(b);
        }

        const statementEntries: any[] = [];
        for (const [, groupBets] of groups) {
          const first = groupBets[0];
          const totalStake = groupBets.reduce((s, b) => s + (Number(b.amount) || 0), 0);
          const wins = groupBets.filter((b) => (Number(b.pnl) || 0) > 0);
          const losses = groupBets.filter((b) => (Number(b.pnl) || 0) < 0);
          const totalCredit = wins.reduce((s, b) => s + (Number(b.pnl) || 0), 0);
          const totalDebit = losses.reduce((s, b) => s + Math.abs(Number(b.pnl) || 0), 0);
          const netPnl = totalCredit - totalDebit;
          const latestSettledAt = groupBets.reduce((max, b) => {
            const t = b.settledAt ? new Date(b.settledAt).getTime() : 0;
            return t > max ? t : max;
          }, 0);
          const description =
            first?.marketName ||
            first?.match?.eventName ||
            (first?.match ? `${first.match.homeTeam || ''} - ${first.match.awayTeam || ''}`.trim() : '') ||
            'Market';
          let result = 'SETTLED';
          if (groupBets.every((b) => b.status === 'WON')) result = 'WON';
          else if (groupBets.every((b) => b.status === 'LOST')) result = 'LOST';
          else if (groupBets.every((b) => b.status === 'CANCELLED')) result = 'CANCELLED';
          else if (netPnl > 0) result = 'WON';
          else if (netPnl < 0) result = 'LOST';

          statementEntries.push({
            marketId: first?.marketId ?? null,
            selectionId: first?.selectionId ?? null,
            description,
            totalStake,
            totalCredit,
            totalDebit,
            netPnl,
            runningBalance: 0, // filled below
            result,
            latestSettledAt: latestSettledAt ? new Date(latestSettledAt).toISOString() : null,
            bets: groupBets.map((b: any) => ({
              id: b.id,
              time: (b.settledAt || b.createdAt) ? new Date(b.settledAt || b.createdAt).toISOString() : null,
              betType: b.betType,
              odds: b.odds,
              stake: Number(b.amount) || 0,
              pnl: Number(b.pnl) ?? 0,
              status: b.status,
            })),
          });
        }

        // Sort by latestSettledAt desc (newest first)
        statementEntries.sort((a, b) => {
          const ta = a.latestSettledAt ? new Date(a.latestSettledAt).getTime() : 0;
          const tb = b.latestSettledAt ? new Date(b.latestSettledAt).getTime() : 0;
          return tb - ta;
        });

        const totalNetPnl = statementEntries.reduce((s, e) => s + (e.netPnl || 0), 0);
        const openingBalance = balance - totalNetPnl;

        // Compute running balance: sort by oldest first, then cumulative
        const byOldest = [...statementEntries].sort((a, b) => {
          const ta = a.latestSettledAt ? new Date(a.latestSettledAt).getTime() : 0;
          const tb = b.latestSettledAt ? new Date(b.latestSettledAt).getTime() : 0;
          return ta - tb;
        });
        let run = openingBalance;
        for (const e of byOldest) {
          e.runningBalance = run + (e.netPnl || 0);
          run = e.runningBalance;
        }
        // Re-sort by newest first for response
        statementEntries.sort((a, b) => {
          const ta = a.latestSettledAt ? new Date(a.latestSettledAt).getTime() : 0;
          const tb = b.latestSettledAt ? new Date(b.latestSettledAt).getTime() : 0;
          return tb - ta;
        });

        const totalRecords = statementEntries.length;
        const page = Math.floor(offset / limit) + 1;
        const paginatedStatement = statementEntries.slice(offset, offset + limit);

        return {
          success: true,
          user: {
            id: user.id,
            openingBalance,
          },
          statement: paginatedStatement,
          pagination: {
            page,
            limit,
            totalRecords,
          },
        };
      });
    }

    // Return basic subordinate information with optional transactions and bet history
    return users.map((user) => {
      const balance = user.wallet?.balance ?? 0;
      const liability = user.wallet?.liability ?? 0;

      // Profit/Loss from userPnl (reporting only - NOT added to balance)
      // Balance already includes settled P/L from settlement.applyOutcome()
      const profitLoss = pnlMap[user.id] ?? 0;

      const baseResponse: any = {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,

        // 💰 WALLET (Betfair standard)
        balance, // Already includes settled P/L
        liability, // Exposure from open bets
        availableBalance: balance - liability, // Playable balance

        // 📊 REPORTING ONLY (not cash)
        profitLoss, // Settled P/L from userPnl (for reporting/display)
        plCash: balance, // Balance already includes P/L, so plCash = balance

        parentId: user.parentId,
        commissionPercentage: user.commissionPercentage,
        isActive: user.isActive ?? true,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

      // Add transactions if requested
      if (includeTransactions) {
        const transferLogs = transferLogsMap.get(user.id) || [];
        const transactions = transferLogs.map((log) => {
          const isCashIn = log.type === TransferLogType.TOPUP && log.toUserId === user.id;
          const isCashOut = log.type === TransferLogType.TOPDOWN && log.fromUserId === user.id;

          return {
            id: log.id,
            date: log.createdAt,
            type: isCashIn ? 'CashIn' : 'CashOut',
            description: isCashIn 
              ? `CashIn To ${log.remarks || ''}`.trim() || 'CashIn To'
              : `CashOut From ${log.remarks || ''}`.trim() || 'CashOut From',
            result: null,
            credit: isCashIn ? log.amount : 0,
            debit: isCashOut ? log.amount : 0,
            balance: 0, // Will be calculated if needed
          };
        });

        baseResponse.transactions = transactions;
      }

      return baseResponse;
    });
  }

  /**
   * Find user by ID or username
   */
  private async findUserByIdOrUsername(identifier: string) {
    // Try to find by ID first
    let user = await this.prisma.user.findUnique({
      where: { id: identifier },
      select: {
        id: true,
        role: true,
        parentId: true,
        username: true,
      },
    });

    // If not found by ID, try username
    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { username: identifier },
        select: {
          id: true,
          role: true,
          parentId: true,
          username: true,
        },
      });
    }

    return user;
  }

  /**
   * Validate that current user can access target user's data based on hierarchy
   */
  private async validateHierarchyAccess(currentUser: User, targetIdentifier: string): Promise<string> {
    // SUPER_ADMIN can access anyone
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      // Still need to find the user to return their ID
      const targetUser = await this.findUserByIdOrUsername(targetIdentifier);
      if (!targetUser) {
        throw new BadRequestException('Target user not found');
      }
      return targetUser.id;
    }

    // Get target user by ID or username
    const targetUser = await this.findUserByIdOrUsername(targetIdentifier);

    if (!targetUser) {
      throw new BadRequestException('Target user not found');
    }

    // Check if target user is in current user's hierarchy
    const isInHierarchy = await this.isUserInHierarchy(currentUser.id, targetUser.id);
    
    if (!isInHierarchy) {
      throw new ForbiddenException('You do not have access to this user\'s data');
    }

    return targetUser.id;
  }

  /**
   * Check if target user is in current user's hierarchy (recursive check)
   */
  private async isUserInHierarchy(currentUserId: string, targetUserId: string): Promise<boolean> {
    // If target is current user, allow
    if (targetUserId === currentUserId) {
      return true;
    }

    // Get all descendants of current user recursively
    const descendants = await this.getAllDescendants(currentUserId);
    return descendants.some(desc => desc.id === targetUserId);
  }

  /**
   * Get all descendants of a user (recursive)
   */
  private async getAllDescendants(userId: string): Promise<Array<{ id: string; role: UserRole }>> {
    const descendants: Array<{ id: string; role: UserRole }> = [];
    const queue: string[] = [userId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = await this.prisma.user.findMany({
        where: { parentId: currentId },
        select: {
          id: true,
          role: true,
        },
      });

      for (const child of children) {
        descendants.push(child);
        queue.push(child.id);
      }
    }

    return descendants;
  }

  /**
   * Get bet history for a CLIENT
   * Only accessible if client is in current user's hierarchy
   */
  private async getClientBetHistory(currentUser: User, clientIdentifier: string) {
    // Validate access and get actual user ID (supports both ID and username)
    const clientId = await this.validateHierarchyAccess(currentUser, clientIdentifier);

    // Get client to verify role
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { role: true },
    });

    if (!client) {
      throw new BadRequestException('Client not found');
    }

    if (client.role !== UserRole.CLIENT) {
      throw new BadRequestException('Bet history is only available for CLIENT users');
    }

    // Get all bets for this client (bet history includes all bets)
    const bets = await this.prisma.bet.findMany({
      where: {
        userId: clientId,
      },
      select: {
        id: true,
        betName: true,
        marketName: true,
        marketType: true,
        betRate: true,
        odds: true,
        betValue: true,
        amount: true,
        pnl: true,
        createdAt: true,
        status: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 1000, // Limit to prevent excessive data
    });

    // Transform to required format
    return bets.map((bet) => ({
      id: bet.id,
      name: bet.betName || null,
      marketName: bet.marketName || null,
      marketType: bet.marketType || null,
      odds: bet.betRate || bet.odds,
      stake: bet.betValue || bet.amount,
      netProfit: bet.pnl || 0, // pnl is the net profit/loss
      createdAt: bet.createdAt,
      status: bet.status,
      // WIN/LOSS derivable from netProfit: positive = WIN, negative = LOSS, zero = CANCELLED/PENDING
    }));
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

  /**
   * Update client details (Agent only)
   * Allows agents to update their client's name, password, commission, and maxWinLimit
   * Username cannot be changed
   */
  async updateClient(currentUser: User, clientId: string, updateClientDto: UpdateClientDto) {
    // Get target client
    const targetClient = await this.prisma.user.findUnique({
      where: { id: clientId },
    });

    if (!targetClient) {
      throw new BadRequestException('Client not found');
    }

    // Validate that target is a CLIENT
    if (targetClient.role !== UserRole.CLIENT) {
      throw new BadRequestException('Can only update CLIENT users');
    }

    // Validate that current user is the parent of target client (agent can only edit their own clients)
    if (currentUser.role === UserRole.AGENT && targetClient.parentId !== currentUser.id) {
      throw new ForbiddenException('You can only update your own clients');
    }

    // For ADMIN and SUPER_ADMIN, validate hierarchy access
    if (currentUser.role !== UserRole.AGENT) {
      const isInHierarchy = await this.isUserInHierarchy(currentUser.id, clientId);
      if (!isInHierarchy) {
        throw new ForbiddenException('You do not have access to update this client');
      }
    }

    // Build update data (only include fields that are provided)
    const updateData: any = {};

    if (updateClientDto.name !== undefined) {
      updateData.name = updateClientDto.name;
    }

    if (updateClientDto.password !== undefined) {
      // Hash the new password
      const saltRounds = 10;
      updateData.password = await bcrypt.hash(updateClientDto.password, saltRounds);
    }

    if (updateClientDto.commissionPercentage !== undefined) {
      updateData.commissionPercentage = updateClientDto.commissionPercentage;
    }

    // Note: maxWinLimit is not in the User model, so we'll skip it for now
    // If it needs to be added, it would require a database migration

    // Update user
    const updatedUser = await this.prisma.user.update({
      where: { id: clientId },
      data: updateData,
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        commissionPercentage: true,
        isActive: true,
        parentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      success: true,
      message: 'Client updated successfully',
      user: updatedUser,
    };
  }
}
