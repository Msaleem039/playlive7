import { IsString, IsNotEmpty } from 'class-validator';

export class UpdateNewsBarDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}
