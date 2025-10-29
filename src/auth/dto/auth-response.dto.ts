import { UserRole } from '@prisma/client';

export class AuthResponseDto {
  user: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
    balance: number;
    createdAt: Date;
    updatedAt: Date;
  };
  accessToken: string;
}

export class UserResponseDto {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}
