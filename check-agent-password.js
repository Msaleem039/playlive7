const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function checkAgentPassword() {
  const prisma = new PrismaClient();
  
  try {
    const agent = await prisma.user.findUnique({
      where: { email: 'agent@gmail.com' }
    });
    
    if (agent) {
      console.log('Agent found:', agent.name, agent.email);
      console.log('Password hash:', agent.password);
      
      // Test password verification
      const isValid = await bcrypt.compare('password123', agent.password);
      console.log('Password verification result:', isValid);
    } else {
      console.log('Agent not found');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAgentPassword();
