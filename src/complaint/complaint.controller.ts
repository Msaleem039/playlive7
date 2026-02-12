import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ComplaintService } from './complaint.service';
import { CreateComplaintDto } from './create-complaint.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('complaint')
export class ComplaintController {
  constructor(private readonly complaintService: ComplaintService) {}

  /**
   * POST /complaint
   * Create a new complaint (Public endpoint - no auth required)
   */
  @Post()
  async createComplaint(@Body() createComplaintDto: CreateComplaintDto) {
    return this.complaintService.createComplaint(createComplaintDto);
  }

  /**
   * GET /complaint
   * Get all complaints (Admin only)
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getAllComplaints() {
    return this.complaintService.getAllComplaints();
  }
}





