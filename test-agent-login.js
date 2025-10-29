const axios = require('axios');

async function testAgentLogin() {
  try {
    const response = await axios.post('http://localhost:3000/auth/login', {
      email: 'agent@gmail.com',
      password: 'password123'
    });
    
    console.log('Agent login successful!');
    console.log('Access Token:', response.data.accessToken);
    console.log('User:', response.data.user);
  } catch (error) {
    console.error('Agent login failed:', error.response?.data || error.message);
  }
}

testAgentLogin();
