const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function createClientDirectly() {
  const prisma = new PrismaClient();
  
  try {
    // Hash the password
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    // Create client user
    const client = await prisma.user.create({
      data: {
        name: 'Jane Client',
        email: 'client@gmail.com',
        password: hashedPassword,
        role: 'CLIENT',
        balance: 500,
        parentId: 'cmh8qyq340001v3k8nnu7y6vp', // Agent as parent
        commissionPercentage: 100
      }
    });
    
    console.log('Client created successfully:', client);
    
    // Test password verification
    const isValid = await bcrypt.compare('password123', client.password);
    console.log('Password verification result:', isValid);
    
  } catch (error) {
    if (error.code === 'P2002') {
      console.log('Client already exists with this email');
    } else {
      console.error('Error creating client:', error);
    }
  } finally {
    await prisma.$disconnect();
  }
}

createClientDirectly();
