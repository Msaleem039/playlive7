const axios = require('axios');

async function getAgentToken() {
  try {
    const response = await axios.post('http://localhost:3000/auth/login', {
      email: 'agent@gmail.com',
      password: 'password123'
    });
    
    console.log('Agent login successful!');
    console.log('Access Token:', response.data.accessToken);
    console.log('User:', response.data.user);
    
    // Now test creating a client with the fresh token
    console.log('\n--- Testing client creation ---');
    const clientResponse = await axios.post('http://localhost:3000/agent/create-client', {
      name: 'Jane Client',
      email: 'client@gmail.com',
      password: 'password123',
      commissionPercentage: 100,
      initialBalance: 500
    }, {
      headers: {
        'Authorization': `Bearer ${response.data.accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Client created successfully!', clientResponse.data);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    console.error('Status:', error.response?.status);
  }
}

getAgentToken();
