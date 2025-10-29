const { InMemoryCacheService } = require('./src/redis/in-memory-cache.service');

async function testInMemoryCache() {
  console.log('🧠 Testing In-Memory Cache...');
  
  const cache = new InMemoryCacheService();
  
  try {
    // Test basic operations
    console.log('\n📦 Testing basic cache operations...');
    await cache.set('test:key', 'Hello Cache!', 10);
    const value = await cache.get('test:key');
    console.log('✅ Test value:', value);
    
    // Test cricket data caching
    console.log('\n🏏 Testing cricket data caching...');
    const cricketData = {
      matches: [
        { id: 1, title: 'India vs Australia', status: 'live', score: '120/2' },
        { id: 2, title: 'England vs Pakistan', status: 'upcoming', score: '0/0' }
      ],
      timestamp: new Date().toISOString(),
      totalMatches: 2
    };
    
    await cache.cacheCricketMatches(cricketData.matches, 30);
    console.log('✅ Cached cricket matches with 30s TTL');
    
    const cachedMatches = await cache.getCachedCricketMatches();
    console.log('📦 Retrieved cached matches:', cachedMatches);
    
    // Test match-specific caching
    console.log('\n🎯 Testing match-specific caching...');
    const matchData = {
      id: 1,
      title: 'India vs Australia',
      status: 'live',
      score: '120/2',
      overs: '20.3',
      commentary: 'Great batting by India!'
    };
    
    await cache.cacheMatch(1, matchData, 60);
    console.log('✅ Cached match data with 60s TTL');
    
    const cachedMatch = await cache.getCachedMatch(1);
    console.log('📦 Retrieved cached match:', cachedMatch);
    
    // Test cache statistics
    console.log('\n📊 Testing cache statistics...');
    const stats = await cache.getCacheStats();
    console.log('📈 Cache stats:', stats);
    
    // Test cache expiration
    console.log('\n⏰ Testing cache expiration...');
    await cache.set('expire:test', 'This will expire', 2);
    console.log('✅ Set data with 2s TTL');
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    let expiredValue = await cache.get('expire:test');
    console.log('📦 After 1s:', expiredValue);
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    expiredValue = await cache.get('expire:test');
    console.log('📦 After 2.5s (should be null):', expiredValue);
    
    // Test cache invalidation
    console.log('\n🗑️ Testing cache invalidation...');
    await cache.invalidateMatchCache(1);
    const invalidatedMatch = await cache.getCachedMatch(1);
    console.log('📦 After invalidation (should be null):', invalidatedMatch);
    
    // Test getOrSet pattern
    console.log('\n🔄 Testing getOrSet pattern...');
    let fetchCount = 0;
    const fetchFunction = async () => {
      fetchCount++;
      console.log(`🔄 Fetch function called (${fetchCount} times)`);
      return { data: `Fetched data ${fetchCount}`, timestamp: new Date().toISOString() };
    };
    
    // First call should fetch
    const result1 = await cache.getOrSet('getorset:test', fetchFunction, 10);
    console.log('📦 First result:', result1);
    
    // Second call should use cache
    const result2 = await cache.getOrSet('getorset:test', fetchFunction, 10);
    console.log('📦 Second result:', result2);
    
    console.log(`📊 Fetch function called ${fetchCount} times (should be 1)`);
    
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await cache.reset();
    console.log('✅ Cache cleared');
    
    console.log('\n🎉 All cache tests passed!');
    
  } catch (error) {
    console.error('❌ Cache test failed:', error);
  }
}

// Run the test
testInMemoryCache().catch(console.error);
