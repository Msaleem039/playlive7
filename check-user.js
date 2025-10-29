const { PrismaClient } = require('@prisma/client');

async function checkUser() {
  const prisma = new PrismaClient();
  
  try {
    const user = await prisma.user.findUnique({
      where: { id: 'cmh8na4850000v3lsudh4mvgx' }
    });
    
    console.log('User found:', user);
    
    if (!user) {
      console.log('User not found! Checking all users:');
      const allUsers = await prisma.user.findMany();
      console.log('All users:', allUsers);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUser();
