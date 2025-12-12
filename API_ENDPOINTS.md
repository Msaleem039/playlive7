# API Endpoints Documentation

Base URL: `http://your-domain.com` (or your production URL)

---

## 📋 Table of Contents

1. [Sports & Series](#sports--series)
2. [Matches](#matches)
3. [Markets & Odds](#markets--odds)
4. [Results](#results)
5. [Place Bet](#place-bet)
6. [WebSocket (Real-time Odds)](#websocket-realtime-odds)

---

## 🏆 Sports & Series

### 1. Get All Sports
Get list of all available sports/events.

**Endpoint:** `GET /cricketid/sports`

**Example Request:**
```bash
curl http://your-domain.com/cricketid/sports
```

**Example Response:**
```json
[
  {
    "competition": {
      "id": "12444379",
      "name": "The Ashes"
    },
    "competitionRegion": "International",
    "marketCount": 22
  },
  {
    "competition": {
      "id": "101480",
      "name": "Indian Premier League"
    },
    "competitionRegion": "IND",
    "marketCount": 1
  }
]
```

---

### 2. Get Cricket Series/Competitions
Get all competitions/series for cricket (sportId = 4).

**Endpoint:** `GET /cricketid/series?sportId=4`

**Query Parameters:**
- `sportId` (required): Sport ID (4 for cricket)

**Example Request:**
```bash
curl "http://your-domain.com/cricketid/series?sportId=4"
```

**Example Response:**
```json
[
  {
    "competition": {
      "id": "9992899",
      "name": "International Twenty20 Matches"
    },
    "competitionRegion": "International",
    "marketCount": 48
  },
  {
    "competition": {
      "id": "101480",
      "name": "Indian Premier League"
    },
    "competitionRegion": "IND",
    "marketCount": 1
  }
]
```

---

## 🏏 Matches

### 3. Get Match Details by Competition
Get all matches for a specific competition/series.

**Endpoint:** `GET /cricketid/matches?sportId=4&competitionId={competitionId}`

**Query Parameters:**
- `competitionId` (required): Competition ID from series list (e.g., "9992899")
- `sportId` (optional): Sport ID (default: 4 for cricket)

**Example Request:**
```bash
curl "http://your-domain.com/cricketid/matches?sportId=4&competitionId=9992899"
```

**Example Response:**
```json
[
  {
    "event": {
      "id": "34917574",
      "name": "Australia v India",
      "countryCode": "GB",
      "timezone": "GMT",
      "openDate": "2025-11-06T08:15:00.000Z"
    },
    "competition": {
      "id": "9992899",
      "name": "International Twenty20 Matches"
    }
  }
]
```

---

## 📊 Markets & Odds

### 4. Get Market List
Get all available markets (betting options) for a specific match/event.

**Endpoint:** `GET /cricketid/markets?eventId={eventId}`

**Query Parameters:**
- `eventId` (required): Event ID from match list (e.g., "34917574")

**Example Request:**
```bash
curl "http://your-domain.com/cricketid/markets?eventId=34917574"
```

**Example Response:**
```json
[
  {
    "marketId": "1.250049502",
    "competition": {
      "id": "9992899",
      "name": "International Twenty20 Matches",
      "provider": "BETFAIR"
    },
    "event": {
      "id": "34917574",
      "name": "Australia v India",
      "countryCode": "GB",
      "timezone": "GMT",
      "openDate": "2025-11-06T08:15:00.000Z"
    },
    "marketName": "2nd Innings 10 Overs Line",
    "runners": [
      {
        "selectionId": 15316,
        "runnerName": "Total Runs",
        "handicap": 0,
        "sortPriority": 1
      }
    ],
    "totalMatched": 0,
    "marketStartTime": "2025-11-06T08:15:00.000Z"
  }
]
```

---

### 5. Get Betfair Odds
Get real-time odds for specific markets.

**Endpoint:** `GET /cricketid/odds?marketIds={marketIds}`

**Query Parameters:**
- `marketIds` (required): Comma-separated market IDs (e.g., "1.250049502,1.250049500")

**Example Request:**
```bash
curl "http://your-domain.com/cricketid/odds?marketIds=1.250049502,1.250049500"
```

**Example Response:**
```json
{
  "status": true,
  "data": [
    {
      "marketId": "1.250049502",
      "isMarketDataDelayed": false,
      "status": "OPEN",
      "betDelay": 0,
      "complete": true,
      "inplay": false,
      "runners": [
        {
          "selectionId": 15316,
          "handicap": 0,
          "status": "ACTIVE",
          "ex": {
            "availableToBack": [
              { "price": 1.85, "size": 100 }
            ],
            "availableToLay": [
              { "price": 1.86, "size": 100 }
            ],
            "tradedVolume": []
          }
        }
      ]
    }
  ]
}
```

---

## 🎯 Results

### 6. Get Betfair Results
Get results for specific markets.

**Endpoint:** `GET /cricketid/results?marketIds={marketIds}`

**Query Parameters:**
- `marketIds` (required): Comma-separated market IDs (e.g., "1.249961303")

**Example Request:**
```bash
curl "http://your-domain.com/cricketid/results?marketIds=1.249961303"
```

**Example Response:**
```json
{
  "status": true,
  "data": [
    {
      "result": {
        "status": "CLOSED",
        "marketId": "1.249961303",
        "eventId": "34917574",
        "sport": "Cricket",
        "isRefund": false,
        "type": "MATCH_ODDS",
        "gtype": "Normal",
        "result": 235,
        "winnerName": "Australia"
      }
    }
  ]
}
```

---

### 7. Get Fancy Result (Even/Odd)
Get fancy bet results for a specific event (includes even/odd bets).

**Endpoint:** `GET /cricketid/fancy-result?eventId={eventId}`

**Query Parameters:**
- `eventId` (required): Event ID (e.g., "34917574")

**Example Request:**
```bash
curl "http://your-domain.com/cricketid/fancy-result?eventId=34917574"
```

**Example Response:**
```json
{
  "status": true,
  "data": [
    {
      "eventId": "34917574",
      "marketName": "Fancy",
      "runners": [
        {
          "selectionId": 1,
          "runnerName": "Even",
          "odds": 1.95
        },
        {
          "selectionId": 2,
          "runnerName": "Odd",
          "odds": 1.90
        }
      ]
    }
  ]
}
```

---

## 💰 Place Bet

### 8. Place Bet (Vendor API - Direct)
Place a bet directly through the vendor API.

**Endpoint:** `POST /cricketid/place-bet`

**Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "marketId": "1.250049502",
  "selectionId": 15316,
  "side": "BACK",
  "size": 100,
  "price": 1.85,
  "eventId": "34917574"
}
```

**Body Parameters:**
- `marketId` (required): Market ID (e.g., "1.250049502")
- `selectionId` (required): Selection ID (number)
- `side` (required): "BACK" or "LAY"
- `size` (required): Bet size/amount (number)
- `price` (required): Odds/price (number)
- `eventId` (optional): Event ID (string)

**Example Request:**
```bash
curl -X POST http://your-domain.com/cricketid/place-bet \
  -H "Content-Type: application/json" \
  -d '{
    "marketId": "1.250049502",
    "selectionId": 15316,
    "side": "BACK",
    "size": 100,
    "price": 1.85,
    "eventId": "34917574"
  }'
```

**Example Response:**
```json
{
  "status": true,
  "betId": "123456",
  "message": "Bet placed successfully"
}
```

---

### 9. Place Bet (Internal API - With User Authentication)
Place a bet through the internal API (requires authentication, handles wallet, exposure, etc.).

**Endpoint:** `POST /bf_placeBet_api`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {JWT_TOKEN}
```

**Request Body:**
```json
{
  "user_id": "user123",
  "match_id": "match456",
  "selection_id": 15316,
  "bet_type": "BACK",
  "bet_name": "Total Runs",
  "bet_rate": 1.85,
  "betvalue": 100,
  "market_name": "2nd Innings 10 Overs Line",
  "market_type": "LINE",
  "marketId": "1.250049502",
  "eventId": "34917574",
  "gtype": "Normal"
}
```

**Body Parameters:**
- `user_id` (required): User ID
- `match_id` (required): Match ID
- `selection_id` (required): Selection ID
- `bet_type` (required): "BACK" or "LAY"
- `bet_name` (optional): Bet name
- `bet_rate` (required): Odds/rate
- `betvalue` (required): Bet amount
- `market_name` (optional): Market name
- `market_type` (optional): Market type
- `marketId` (optional): Vendor market ID
- `eventId` (optional): Vendor event ID
- `gtype` (optional): Game type (Normal, fancy, fancy1, oddeven)

**Example Request:**
```bash
curl -X POST http://your-domain.com/bf_placeBet_api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "user_id": "user123",
    "match_id": "match456",
    "selection_id": 15316,
    "bet_type": "BACK",
    "bet_rate": 1.85,
    "betvalue": 100,
    "marketId": "1.250049502",
    "eventId": "34917574"
  }'
```

**Example Response:**
```json
{
  "success": true,
  "betId": "bet789",
  "message": "Bet placed successfully"
}
```

---

## 🔌 WebSocket (Real-time Odds)

### 10. WebSocket Connection for Real-time Odds
Connect via WebSocket to receive real-time odds updates.

**Connection URL:** `ws://your-domain.com` (or `wss://` for HTTPS)

**Subscribe to Match Odds:**
```javascript
// Connect to WebSocket
const socket = io('http://your-domain.com');

// Subscribe to match odds
socket.emit('subscribe_match', {
  eventId: '34917574',  // OR
  marketIds: '1.250049502,1.250049500'
});

// Listen for odds updates
socket.on('odds_update', (data) => {
  console.log('Odds updated:', data);
});

// Unsubscribe
socket.emit('unsubscribe_match', {
  eventId: '34917574'
});
```

**Events:**
- `subscribe_match`: Subscribe to odds updates for a match
  - Body: `{ eventId?: string, marketIds?: string }`
- `unsubscribe_match`: Unsubscribe from odds updates
  - Body: `{ eventId?: string, marketIds?: string }`
- `odds_update`: Receive real-time odds updates (emitted by server)

---

## 📝 Complete Flow Example

### Step-by-step betting flow:

1. **Get all sports:**
   ```bash
   GET /cricketid/sports
   ```

2. **Get cricket series:**
   ```bash
   GET /cricketid/series?sportId=4
   ```

3. **Get matches for a series:**
   ```bash
   GET /cricketid/matches?sportId=4&competitionId=9992899
   ```

4. **Get markets for a match:**
   ```bash
   GET /cricketid/markets?eventId=34917574
   ```

5. **Get odds for markets:**
   ```bash
   GET /cricketid/odds?marketIds=1.250049502,1.250049500
   ```

6. **Place a bet:**
   ```bash
   POST /bf_placeBet_api
   {
     "user_id": "user123",
     "match_id": "match456",
     "selection_id": 15316,
     "bet_type": "BACK",
     "bet_rate": 1.85,
     "betvalue": 100,
     "marketId": "1.250049502",
     "eventId": "34917574"
   }
   ```

7. **Get results:**
   ```bash
   GET /cricketid/results?marketIds=1.249961303
   ```

8. **Get fancy/even-odd results:**
   ```bash
   GET /cricketid/fancy-result?eventId=34917574
   ```

---

## 🔐 Authentication

Most endpoints are public, but the internal bet placement endpoint (`/bf_placeBet_api`) requires JWT authentication:

```
Authorization: Bearer {JWT_TOKEN}
```

---

## ⚠️ Error Responses

All endpoints may return errors in this format:

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

Common HTTP Status Codes:
- `200`: Success
- `400`: Bad Request (invalid parameters)
- `401`: Unauthorized (missing/invalid token)
- `500`: Internal Server Error

---

## 📌 Notes

- All endpoints use the base URL: `https://vendorapi.tresting.com` internally
- Market IDs are strings (e.g., "1.250049502")
- Event IDs can be strings or numbers
- Selection IDs are numbers
- Odds are updated every 2.5 seconds via WebSocket
- Results are available after the market closes

