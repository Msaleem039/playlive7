const axios = require('axios');

async function createClientWithAgent() {
  const agentToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWg4cXlxMzQwMDAxdjNrOG5udTd5NnZwIiwicm9sZSI6IkFHRU5UIiwiaWF0IjoxNzYxNTQ4MTg1LCJleHAiOjE3NjIxNTI5ODV9.sSu3h2MRKraY00bHVbUMkXRSJPLb_VXNEJ9OE_okNXs';
  
  try {
    console.log('Creating client user...');
    
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
    
    console.log('Client created successfully!');
    console.log('Client ID:', response.data.id);
    console.log('Client Name:', response.data.name);
    console.log('Client Email:', response.data.email);
    console.log('Client Role:', response.data.role);
    
    // Now test client login
    console.log('\n--- Testing client login ---');
    const loginResponse = await axios.post('http://localhost:3000/auth/login', {
      email: 'client@gmail.com',
      password: 'password123'
    });
    
    console.log('Client login successful!');
    console.log('Client Token:', loginResponse.data.accessToken);
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    console.error('Status:', error.response?.status);
  }
}

createClientWithAgent();
