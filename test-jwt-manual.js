const jwt = require('jsonwebtoken');

// Test JWT token generation and verification
const secret = 'your-super-secret-jwt-key-change-this-in-production-12345';
const payload = { sub: 'cmh8na4850000v3lsudh4mvgx', role: 'SUPER_ADMIN' };

console.log('Original payload:', payload);

// Generate token
const token = jwt.sign(payload, secret, { expiresIn: '7d' });
console.log('Generated token:', token);

// Verify token
try {
  const decoded = jwt.verify(token, secret);
  console.log('Decoded payload:', decoded);
  console.log('Token verification: SUCCESS');
} catch (error) {
  console.error('Token verification failed:', error.message);
}
