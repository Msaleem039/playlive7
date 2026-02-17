import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class CreateComplaintDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  contactNumber: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  message: string;
}









