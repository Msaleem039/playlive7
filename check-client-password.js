const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function checkClientPassword() {
  const prisma = new PrismaClient();
  
  try {
    const client = await prisma.user.findUnique({
      where: { email: 'client@gmail.com' }
    });
    
    if (client) {
      console.log('Client found:', client.name, client.email);
      console.log('Password hash:', client.password);
      
      // Test password verification
      const isValid = await bcrypt.compare('password123', client.password);
      console.log('Password verification result:', isValid);
      
      if (!isValid) {
        console.log('Fixing client password...');
        const hashedPassword = await bcrypt.hash('password123', 10);
        await prisma.user.update({
          where: { email: 'client@gmail.com' },
          data: { password: hashedPassword }
        });
        console.log('Client password fixed!');
      }
    } else {
      console.log('Client not found');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkClientPassword();
