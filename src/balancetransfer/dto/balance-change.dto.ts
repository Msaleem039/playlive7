import { IsNumber,IsString,Min } from "class-validator";

export class BalanceChangeDto {
    @IsNumber()
    @Min(1)
    balance: number;

    @IsString()
    remarks: string;
}