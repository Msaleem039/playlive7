const axios = require('axios');

async function testLogin() {
  try {
    const response = await axios.post('http://localhost:3000/auth/login', {
      email: 'admin@gmail.com',
      password: 'password123'
    });
    
    console.log('Login successful!');
    console.log('Access Token:', response.data.accessToken);
    console.log('User:', response.data.user);
  } catch (error) {
    console.error('Login failed:', error.response?.data || error.message);
  }
}

testLogin();
