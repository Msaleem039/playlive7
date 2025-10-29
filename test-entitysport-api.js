const axios = require('axios');

async function testEntitySportAPI() {
  const BASE_URL = 'https://restapi.entitysport.com/exchange';
  const API_TOKEN = 'd38dee8f66ed335ade8562f873db7468';
  
  console.log('=== Testing EntitySport API ===');
  console.log('Base URL:', BASE_URL);
  console.log('API Token:', API_TOKEN);
  console.log('');

  // Test 1: Get matches
  try {
    console.log('1. Testing /matches endpoint...');
    const matchesResponse = await axios.get(`${BASE_URL}/matches`, {
      params: {
        token: API_TOKEN,
        status: '2' // Completed matches
      }
    });
    
    console.log('✅ Matches endpoint working');
    console.log('Response status:', matchesResponse.status);
    console.log('Response data keys:', Object.keys(matchesResponse.data));
    
    if (matchesResponse.data.response && matchesResponse.data.response.items) {
      console.log('Number of matches:', matchesResponse.data.response.items.length);
      if (matchesResponse.data.response.items.length > 0) {
        console.log('First match:', matchesResponse.data.response.items[0]);
      }
    }
  } catch (error) {
    console.error('❌ Matches endpoint failed:', error.response?.status, error.response?.statusText);
    console.error('Error details:', error.response?.data);
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 2: Get competitions
  try {
    console.log('2. Testing /competitions endpoint...');
    const competitionsResponse = await axios.get(`${BASE_URL}/competitions`, {
      params: {
        token: API_TOKEN
      }
    });
    
    console.log('✅ Competitions endpoint working');
    console.log('Response status:', competitionsResponse.status);
    console.log('Response data keys:', Object.keys(competitionsResponse.data));
    
    if (competitionsResponse.data.response && competitionsResponse.data.response.items) {
      console.log('Number of competitions:', competitionsResponse.data.response.items.length);
    }
  } catch (error) {
    console.error('❌ Competitions endpoint failed:', error.response?.status, error.response?.statusText);
    console.error('Error details:', error.response?.data);
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 3: Get live matches (status = 1)
  try {
    console.log('3. Testing live matches (status=1)...');
    const liveMatchesResponse = await axios.get(`${BASE_URL}/matches`, {
      params: {
        token: API_TOKEN,
        status: '1' // Live matches
      }
    });
    
    console.log('✅ Live matches endpoint working');
    console.log('Response status:', liveMatchesResponse.status);
    console.log('Response data keys:', Object.keys(liveMatchesResponse.data));
    
    if (liveMatchesResponse.data.response && liveMatchesResponse.data.response.items) {
      console.log('Number of live matches:', liveMatchesResponse.data.response.items.length);
      if (liveMatchesResponse.data.response.items.length > 0) {
        console.log('Live match example:', liveMatchesResponse.data.response.items[0]);
      }
    }
  } catch (error) {
    console.error('❌ Live matches endpoint failed:', error.response?.status, error.response?.statusText);
    console.error('Error details:', error.response?.data);
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Test 4: Test WebSocket connection
  console.log('4. Testing WebSocket connection...');
  const WebSocket = require('ws');
  
  try {
    const wsUrl = `ws://webhook.entitysport.com:8087/connect?token=${API_TOKEN}`;
    console.log('WebSocket URL:', wsUrl);
    
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
      console.log('✅ WebSocket connected successfully');
      
      // Subscribe to a match
      const subscribeMessage = JSON.stringify({
        type: "subscribe",
        match_id: 75469
      });
      
      ws.send(subscribeMessage);
      console.log('📡 Sent subscription message for match 75469');
    });
    
    ws.on('message', (data) => {
      console.log('📡 Received WebSocket message:', data.toString());
    });
    
    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
    });
    
    ws.on('close', (code, reason) => {
      console.log(`WebSocket closed. Code: ${code}, Reason: ${reason}`);
    });
    
    // Close after 10 seconds
    setTimeout(() => {
      ws.close();
      console.log('WebSocket connection closed after test');
    }, 10000);
    
  } catch (error) {
    console.error('❌ WebSocket connection failed:', error.message);
  }
}

testEntitySportAPI();
