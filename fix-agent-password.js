const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function fixAgentPassword() {
  const prisma = new PrismaClient();
  
  try {
    // Hash the password
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    // Update agent password
    const agent = await prisma.user.update({
      where: { email: 'agent@gmail.com' },
      data: { password: hashedPassword }
    });
    
    console.log('Agent password updated successfully');
    console.log('New password hash:', agent.password);
    
    // Test password verification
    const isValid = await bcrypt.compare('password123', agent.password);
    console.log('Password verification result:', isValid);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixAgentPassword();
