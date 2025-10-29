const axios = require('axios');

async function createAgent() {
  const adminToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWg4cWphbzQwMDAxdjM2NGM2OTBtbzNvIiwicm9sZSI6IkFETUlOIiwiaWF0IjoxNzYxNTQ2OTI4LCJleHAiOjE3NjIxNTE3Mjh9.tTAL2yHwdN8o7m944erw1wlMUQjLa-SO-LFum0J-aPk';
  
  try {
    console.log('Creating agent user...');
    
    const response = await axios.post('http://localhost:3000/admin/create-agent', {
      name: 'John Agent',
      email: 'agent@gmail.com',
      password: 'password123',
      commissionPercentage: 20,
      initialBalance: 1000
    }, {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Agent created successfully!', response.data);
  } catch (error) {
    console.error('Error creating agent:', error.response?.data || error.message);
    console.error('Status:', error.response?.status);
  }
}

createAgent();
