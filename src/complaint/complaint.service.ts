import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateComplaintDto } from './create-complaint.dto';

@Injectable()
export class ComplaintService {
  private readonly logger = new Logger(ComplaintService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new complaint
   */
  async createComplaint(createComplaintDto: CreateComplaintDto) {
    try {
      const complaint = await this.prisma.complaint.create({
        data: {
          name: createComplaintDto.name,
          contactNumber: createComplaintDto.contactNumber,
          message: createComplaintDto.message,
          status: 'PENDING',
        },
      });

      this.logger.log(`New complaint created: ${complaint.id} from ${complaint.name}`);

      return {
        success: true,
        message: 'Complaint submitted successfully',
        data: {
          id: complaint.id,
          name: complaint.name,
          contactNumber: complaint.contactNumber,
          message: complaint.message,
          status: complaint.status,
          createdAt: complaint.createdAt,
        },
      };
    } catch (error) {
      this.logger.error(`Error creating complaint: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get all complaints (Admin only)
   */
  async getAllComplaints() {
    const complaints = await this.prisma.complaint.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: complaints,
      count: complaints.length,
    };
  }
}













