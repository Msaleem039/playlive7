const axios = require('axios');

async function testCreateUser() {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWg4bmE0ODUwMDAwdjNsc3VkaDRtdmd4Iiwicm9sZSI6IlNVUEVSX0FETUlOIiwiaWF0IjoxNzYxNTQ1MDUzLCJleHAiOjE3NjIxNDk4NTN9.J6pcsQfAT8mye_kxEER2YftR250hQ2KDrk8d3VXstDU';
  
  try {
    console.log('Testing create-user endpoint...');
    
    const response = await axios.post('http://localhost:3000/auth/create-user', {
      name: 'John Admin',
      email: 'admin@gmail.com',
      password: 'password123',
      role: 'ADMIN',
      commissionPercentage: 15
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

testCreateUser();
