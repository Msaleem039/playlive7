const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function createAgentDirectly() {
  const prisma = new PrismaClient();
  
  try {
    // Hash the password
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    // Create agent user
    const agent = await prisma.user.create({
      data: {
        name: 'John Agent',
        email: 'agent@gmail.com',
        password: hashedPassword,
        role: 'AGENT',
        balance: 1000,
        parentId: 'cmh8na4850000v3lsudh4mvgx', // SuperAdmin as parent
        commissionPercentage: 20
      }
    });
    
    console.log('Agent created successfully:', agent);
  } catch (error) {
    console.error('Error creating agent:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createAgentDirectly();
