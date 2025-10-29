const axios = require('axios');

async function testClientLogin() {
  try {
    const response = await axios.post('http://localhost:3000/auth/login', {
      email: 'client@gmail.com',
      password: 'password123'
    });
    
    console.log('=== CLIENT LOGIN SUCCESSFUL ===');
    console.log('Client Token:', response.data.accessToken);
    console.log('Client Info:', JSON.stringify(response.data.user, null, 2));
  } catch (error) {
    console.error('Client login failed:', error.response?.data || error.message);
  }
}

testClientLogin();
