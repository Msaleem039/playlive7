const axios = require('axios');

async function testCreateClient() {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWg4cWphbzQwMDAxdjM2NGM2OTBtbzNvIiwicm9sZSI6IkFETUlOIiwiaWF0IjoxNzYxNTQ2OTI4LCJleHAiOjE3NjIxNTE3Mjh9.tTAL2yHwdN8o7m944erw1wlMUQjLa-SO-LFum0J-aPk';
  
  try {
    console.log('Testing create-client endpoint...');
    
    const response = await axios.post('http://localhost:3000/admin/create-agent', {
      name: 'John Agent',
      email: 'agent@gmail.com',
      password: 'password123',
      commissionPercentage: 20,
      initialBalance: 1000
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Success!', response.data);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    console.error('Status:', error.response?.status);
  }
}

testCreateClient();
