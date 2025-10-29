const Redis = require('redis');

async function testRedisConnection() {
  console.log('🔌 Testing Redis connection...');
  
  const client = Redis.createClient({
    host: 'localhost',
    port: 6379,
    db: 0
  });

  try {
    await client.connect();
    console.log('✅ Redis connected successfully!');
    
    // Test basic operations
    await client.set('test:key', 'Hello Redis!');
    const value = await client.get('test:key');
    console.log('📦 Test value:', value);
    
    // Test cricket data caching
    const cricketData = {
      matches: [
        { id: 1, title: 'India vs Australia', status: 'live' },
        { id: 2, title: 'England vs Pakistan', status: 'upcoming' }
      ],
      timestamp: new Date().toISOString()
    };
    
    await client.setEx('cricket:matches:live', 30, JSON.stringify(cricketData));
    console.log('🏏 Cached cricket data with 30s TTL');
    
    const cachedData = await client.get('cricket:matches:live');
    console.log('📦 Retrieved cached data:', JSON.parse(cachedData));
    
    // Test cache expiration
    console.log('⏰ Waiting 2 seconds to test TTL...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const ttl = await client.ttl('cricket:matches:live');
    console.log('⏱️ TTL remaining:', ttl, 'seconds');
    
    // Cleanup
    await client.del('test:key');
    await client.del('cricket:matches:live');
    console.log('🧹 Cleaned up test data');
    
  } catch (error) {
    console.error('❌ Redis connection failed:', error.message);
    console.log('\n💡 Make sure Redis is running:');
    console.log('   - Windows: Download Redis from https://github.com/microsoftarchive/redis/releases');
    console.log('   - Docker: docker run -d -p 6379:6379 redis:alpine');
    console.log('   - Linux: sudo apt install redis-server');
  } finally {
    await client.disconnect();
    console.log('🔌 Redis disconnected');
  }
}

testRedisConnection();
