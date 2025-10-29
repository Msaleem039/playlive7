const axios = require('axios');

async function testCreateClient() {
  const agentToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWg4cXlxMzQwMDAxdjNrOG5udTd5NnZwIiwicm9sZSI6IkFHRU5UIiwiaWF0IjoxNzYxNTQ3MjMyLCJleHAiOjE3NjIxNTIwMzJ9.nPyhS1txqFC7KdVWv4upeP10rMidntcIsCD2zhiynOM';
  
  try {
    console.log('Testing create-client endpoint...');
    
    const response = await axios.post('http://localhost:3000/agent/create-client', {
      name: 'Jane Client',
      email: 'client@gmail.com',
      password: 'password123',
      commissionPercentage: 100,
      initialBalance: 500
    }, {
      headers: {
        'Authorization': `Bearer ${agentToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Client created successfully!', response.data);
  } catch (error) {
    console.error('Error creating client:', error.response?.data || error.message);
    console.error('Status:', error.response?.status);
  }
}

testCreateClient();
