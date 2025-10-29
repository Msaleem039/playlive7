const axios = require('axios');

async function getToken() {
  try {
    const response = await axios.post('http://localhost:3000/auth/login', {
      email: 'agent@gmail.com',
      password: 'password123'
    });
    
    console.log('=== AGENT TOKEN FOR POSTMAN ===');
    console.log('Copy this token to your Postman Authorization header:');
    console.log(response.data.accessToken);
    console.log('\n=== USER INFO ===');
    console.log(JSON.stringify(response.data.user, null, 2));
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

getToken();
