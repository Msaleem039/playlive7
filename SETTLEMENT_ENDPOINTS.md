# Settlement Endpoints Documentation

## Overview
This document lists all available settlement-related endpoints in the PlayLive backend API.

---

## 🔐 User Endpoints (Requires JWT Authentication)

Base URL: `/settlement`

All endpoints require `Authorization: Bearer {JWT_TOKEN}` header.

### 1. Get My Pending Bets
**Endpoint:** `GET /settlement/bets/me/pending`

**Description:** Get all pending bets for the authenticated user.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "bet_id",
      "userId": "user_id",
      "matchId": "match_id",
      "amount": 100,
      "odds": 1.85,
      "status": "PENDING",
      "settlementId": "CRICKET:FANCY:eventId:selectionId",
      "match": { ... },
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "count": 5
}
```

---

### 2. Get My Settled Bets
**Endpoint:** `GET /settlement/bets/me/settled`

**Description:** Get all settled bets (WON, LOST, or CANCELLED) for the authenticated user.

**Query Parameters:**
- `status` (optional): Filter by status - `WON`, `LOST`, or `CANCELLED`

**Example:** `GET /settlement/bets/me/settled?status=WON`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "bet_id",
      "userId": "user_id",
      "status": "WON",
      "pnl": 85,
      "settledAt": "2024-01-01T00:00:00.000Z",
      "match": { ... }
    }
  ],
  "count": 10
}
```

---

### 3. Get My All Bets
**Endpoint:** `GET /settlement/bets/me`

**Description:** Get all bets for the authenticated user with optional status filter.

**Query Parameters:**
- `status` (optional): Filter by bet status - `PENDING`, `WON`, `LOST`, or `CANCELLED`

**Example:** `GET /settlement/bets/me?status=PENDING`

**Response:**
```json
{
  "success": true,
  "data": [ ... ],
  "count": 15
}
```

---

## 👨‍💼 Admin Endpoints (Requires Admin/SuperAdmin Role)

Base URL: `/admin/settlement`

All endpoints require:
- `Authorization: Bearer {JWT_TOKEN}` header
- User must have `ADMIN`, `SUPER_ADMIN`, or `SETTLEMENT_ADMIN` role

### 4. Manual Settlement - Fancy
**Endpoint:** `POST /admin/settlement/fancy`

**Description:** Manually settle fancy bets for a specific event and selection. This allows admins to manually settle fancy bets instead of waiting for automatic settlement.

**Request Body:**
```json
{
  "eventId": "34917574",
  "selectionId": "15316",
  "decisionRun": 45,
  "isCancel": false,
  "marketId": "1.250049502"
}
```

**Request Body Parameters:**
- `eventId` (required): Event ID from vendor API
- `selectionId` (required): Selection ID for the fancy
- `decisionRun` (optional): The winning run value (required if `isCancel` is false)
- `isCancel` (required): Boolean - true to cancel/refund, false to settle with decisionRun
- `marketId` (optional): Market ID from vendor API
- `betIds` (optional, array of strings): Specific bet IDs to settle. If not provided, settles ALL pending bets for the market. Example: `["bet_id_1", "bet_id_2"]`

**Example - Settle with Decision Run:**
```json
{
  "eventId": "34917574",
  "selectionId": "15316",
  "decisionRun": 45,
  "isCancel": false,
  "marketId": "1.250049502"
}
```

**Example - Cancel/Refund:**
```json
{
  "eventId": "34917574",
  "selectionId": "15316",
  "isCancel": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Fancy bets settled successfully"
}
```

**Settlement Logic:**
- If `isCancel` is true: All bets are refunded (status = CANCELLED, P/L = lossAmount - refunds the locked liability)
- If `isCancel` is false and `decisionRun` is provided:
  - **BACK bets**: Win if `decisionRun > betValue`, Lose otherwise
  - **LAY bets**: Win if `decisionRun <= betValue`, Lose otherwise

---

### 5. Manual Settlement - Match Odds
**Endpoint:** `POST /admin/settlement/match-odds`

**Description:** Manually settle match odds bets for a specific event and market.

**Request Body:**
```json
{
  "eventId": "34917574",
  "marketId": "1.250049502",
  "winnerSelectionId": "15316",
  "betIds": ["cmjiq4ktk001hv3x4qiefklas", "cmjirfxnd002bv3x4jawqqf45"]
}
```

**Request Body Parameters:**
- `eventId` (required): Event ID from vendor API
- `marketId` (required): Market ID from vendor API
- `winnerSelectionId` (required): The winning selection ID
- `betIds` (optional, array of strings): Specific bet IDs to settle. If not provided, settles ALL pending bets for the market. Example: `["bet_id_1", "bet_id_2"]`

**Example - Settle All Bets (default behavior):**
```json
{
  "eventId": "34917574",
  "marketId": "1.250049502",
  "winnerSelectionId": "15316"
}
```

**Example - Settle Specific Bets Only:**
```json
{
  "eventId": "34917574",
  "marketId": "1.250049502",
  "winnerSelectionId": "15316",
  "betIds": ["cmjiq4ktk001hv3x4qiefklas", "cmjirfxnd002bv3x4jawqqf45"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Match odds bets settled successfully"
}
```

---

### 6. Manual Settlement - Bookmaker
**Endpoint:** `POST /admin/settlement/bookmaker`

**Description:** Manually settle bookmaker bets for a specific event and market.

**Request Body:**
```json
{
  "eventId": "34917574",
  "marketId": "1.250049502",
  "winnerSelectionId": "15316",
  "betIds": ["cmjiq4ktk001hv3x4qiefklas", "cmjirfxnd002bv3x4jawqqf45"]
}
```

**Request Body Parameters:**
- `eventId` (required): Event ID from vendor API
- `marketId` (required): Market ID from vendor API
- `winnerSelectionId` (required): The winning selection ID
- `betIds` (optional, array of strings): Specific bet IDs to settle. If not provided, settles ALL pending bets for the market. Example: `["bet_id_1", "bet_id_2"]`

**Example - Settle All Bets (default behavior):**
```json
{
  "eventId": "34917574",
  "marketId": "1.250049502",
  "winnerSelectionId": "15316"
}
```

**Example - Settle Specific Bets Only:**
```json
{
  "eventId": "34917574",
  "marketId": "1.250049502",
  "winnerSelectionId": "15316",
  "betIds": ["cmjiq4ktk001hv3x4qiefklas", "cmjirfxnd002bv3x4jawqqf45"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Bookmaker bets settled successfully"
}
```

---

### 7. Rollback Settlement
**Endpoint:** `POST /admin/settlement/rollback`

**Description:** Rollback a previously settled settlement. This will:
- Reverse wallet transactions
- Reset bet statuses to PENDING
- Mark the settlement as rolled back

**Authentication:** Required (Bearer Token)
- Roles: `SUPER_ADMIN`, `ADMIN`, `SETTLEMENT_ADMIN`

**Request Body (JSON):**
```json
{
  "settlementId": "CRICKET:MATCHODDS:34917574:1.250049502"
}
```

**Request Body Fields:**
- `settlementId` (string, required): The settlement ID to rollback
  - Format: `CRICKET:{MARKET_TYPE}:{EVENT_ID}:{MARKET_ID}`
  - Examples:
    - Fancy: `CRICKET:FANCY:34917574:12345`
    - Match Odds: `CRICKET:MATCHODDS:34917574:1.250049502`
    - Bookmaker: `CRICKET:BOOKMAKER:34917574:1.250049502`
- `betIds` (optional, array of strings): Specific bet IDs to rollback. If not provided, rolls back ALL bets for the settlement. Example: `["bet_id_1", "bet_id_2"]`

**How to get settlementId:**
1. Use `GET /admin/settlement/list` to see all settlements
2. Copy the `settlementId` from the settlement you want to rollback
3. The settlement must exist and not already be rolled back

**Postman Example:**
- **Method:** `POST`
- **URL:** `http://localhost:3000/admin/settlement/rollback`
- **Headers:**
  ```
  Authorization: Bearer YOUR_JWT_TOKEN
  Content-Type: application/json
  ```
- **Body (raw JSON) - Rollback All Bets:**
  ```json
  {
    "settlementId": "CRICKET:MATCHODDS:34917574:1.250049502"
  }
  ```

- **Body (raw JSON) - Rollback Specific Bets:**
  ```json
  {
    "settlementId": "CRICKET:MATCHODDS:34917574:1.250049502",
    "betIds": ["cmjiq4ktk001hv3x4qiefklas", "cmjirfxnd002bv3x4jawqqf45"]
  }
  ```

**Success Response (200 OK):**
```json
{
  "success": true,
  "message": "Settlement rolled back successfully"
}
```

**Error Responses:**

**400 Bad Request - Missing settlementId:**
```json
{
  "success": false,
  "message": "settlementId is required"
}
```

**404 Not Found - Settlement doesn't exist:**
```json
{
  "success": false,
  "message": "Settlement not found"
}
```

**400 Bad Request - Already rolled back:**
```json
{
  "success": false,
  "message": "Settlement has already been rolled back"
}
```

---

### 8. Get All Pending Bets by Match
**Endpoint:** `GET /admin/settlement/pending`

**Description:** Get all pending bets grouped by match title. Shows fancy, match-odds, and bookmaker pending bets for each match.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "eventId": "34917574",
      "matchTitle": "Team A vs Team B",
      "homeTeam": "Team A",
      "awayTeam": "Team B",
      "startTime": "2024-01-15T10:00:00.000Z",
      "fancy": {
        "count": 5,
        "totalAmount": 5000,
        "bets": [
          {
            "id": "bet_id",
            "amount": 1000,
            "odds": 1.85,
            "betType": "BACK",
            "betName": "Fancy Bet",
            "settlementId": "CRICKET:FANCY:34917574:15316",
            "createdAt": "2024-01-15T09:00:00.000Z"
          }
        ]
      },
      "matchOdds": {
        "count": 3,
        "totalAmount": 3000,
        "bets": [...]
      },
      "bookmaker": {
        "count": 2,
        "totalAmount": 2000,
        "bets": [...]
      }
    }
  ],
  "totalMatches": 4,
  "totalPendingBets": 25
}
```

---

### 9. Get Pending Bets by Market Type
**Endpoint:** `GET /admin/settlement/pending/:marketType`

**Description:** Get pending bets for a specific market type (fancy, match-odds, or bookmaker) grouped by match.

**Path Parameters:**
- `marketType` (required): `fancy`, `match-odds`, or `bookmaker`

**Examples:**
- `GET /admin/settlement/pending/fancy`
- `GET /admin/settlement/pending/match-odds`
- `GET /admin/settlement/pending/bookmaker`

**Response:**
```json
{
  "success": true,
  "marketType": "fancy",
  "data": [
    {
      "eventId": "34917574",
      "matchTitle": "Team A vs Team B",
      "homeTeam": "Team A",
      "awayTeam": "Team B",
      "startTime": "2024-01-15T10:00:00.000Z",
      "bets": [
        {
          "id": "bet_id",
          "amount": 1000,
          "odds": 1.85,
          "betType": "BACK",
          "betName": "Fancy Bet",
          "settlementId": "CRICKET:FANCY:34917574:15316",
          "createdAt": "2024-01-15T09:00:00.000Z"
        }
      ],
      "totalAmount": 5000
    }
  ],
  "totalMatches": 4,
  "totalPendingBets": 15
}
```

---

### 11. Get Settlement History
**Endpoint:** `GET /admin/settlement/history`

**Description:** Get all settlement history with detailed information including bet counts, amounts, and statistics. Useful for reviewing past settlements and identifying any issues.

**Query Parameters:**
- `eventId` (optional): Filter by event ID
- `marketType` (optional): Filter by market type - `FANCY`, `MATCH_ODDS`, or `BOOKMAKER`
- `isRollback` (optional): Filter by rollback status - `true` or `false`
- `settledBy` (optional): Filter by who settled (user ID or "AUTO")
- `startDate` (optional): Filter from date (ISO string, e.g., "2024-01-01T00:00:00.000Z")
- `endDate` (optional): Filter to date (ISO string)
- `limit` (optional): Number of results per page (default: 100, max recommended: 1000)
- `offset` (optional): Pagination offset (default: 0)

**Examples:**
- `GET /admin/settlement/history` - Get all settlements
- `GET /admin/settlement/history?marketType=FANCY` - Get only fancy settlements
- `GET /admin/settlement/history?isRollback=false&limit=50` - Get active settlements (not rolled back)
- `GET /admin/settlement/history?eventId=34917574` - Get settlements for specific event
- `GET /admin/settlement/history?startDate=2024-01-01T00:00:00.000Z&endDate=2024-01-31T23:59:59.999Z` - Get settlements in date range

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "settlement_id",
      "settlementId": "CRICKET:FANCY:34917574:15316",
      "eventId": "34917574",
      "marketType": "FANCY",
      "marketId": "1.250049502",
      "winnerId": "45",
      "settledBy": "admin_user_id",
      "isRollback": false,
      "createdAt": "2024-01-15T10:00:00.000Z",
      "match": {
        "id": "match_id",
        "eventId": "34917574",
        "eventName": "Team A vs Team B",
        "homeTeam": "Team A",
        "awayTeam": "Team B"
      },
      "statistics": {
        "totalBets": 10,
        "wonBets": 5,
        "lostBets": 4,
        "cancelledBets": 1,
        "totalStake": 10000,
        "totalPnl": 2500,
        "totalWinAmount": 5000,
        "totalLossAmount": 2500
      },
      "bets": [
        {
          "id": "bet_id",
          "userId": "user_id",
          "userName": "John Doe",
          "userUsername": "johndoe",
          "amount": 1000,
          "odds": 1.85,
          "betType": "BACK",
          "betName": "Fancy Bet",
          "status": "WON",
          "pnl": 850,
          "settledAt": "2024-01-15T10:00:00.000Z",
          "rollbackAt": null,
          "createdAt": "2024-01-15T09:00:00.000Z"
        }
      ]
    }
  ],
  "pagination": {
    "total": 150,
    "limit": 100,
    "offset": 0,
    "hasMore": true
  }
}
```

---

### 12. Get Single Settlement by ID
**Endpoint:** `GET /admin/settlement/history/:settlementId`

**Description:** Get detailed information about a specific settlement by its settlementId. Useful for reviewing a specific settlement before rollback.

**Path Parameters:**
- `settlementId` (required): The settlement ID (e.g., "CRICKET:FANCY:34917574:15316")

**Example:**
- `GET /admin/settlement/history/CRICKET:FANCY:34917574:15316`

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "settlement_id",
    "settlementId": "CRICKET:FANCY:34917574:15316",
    "eventId": "34917574",
    "marketType": "FANCY",
    "marketId": "1.250049502",
    "winnerId": "45",
    "settledBy": "admin_user_id",
    "isRollback": false,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "match": {
      "id": "match_id",
      "eventId": "34917574",
      "eventName": "Team A vs Team B",
      "homeTeam": "Team A",
      "awayTeam": "Team B"
    },
    "statistics": {
      "totalBets": 10,
      "wonBets": 5,
      "lostBets": 4,
      "cancelledBets": 1,
      "totalStake": 10000,
      "totalPnl": 2500,
      "totalWinAmount": 5000,
      "totalLossAmount": 2500
    },
    "bets": [
      {
        "id": "bet_id",
        "userId": "user_id",
        "userName": "John Doe",
        "userUsername": "johndoe",
        "amount": 1000,
        "odds": 1.85,
        "betType": "BACK",
        "betName": "Fancy Bet",
        "status": "WON",
        "pnl": 850,
        "settledAt": "2024-01-15T10:00:00.000Z",
        "rollbackAt": null,
        "createdAt": "2024-01-15T09:00:00.000Z"
      }
    ]
  }
}
```

---

## 🤖 Automatic Settlement

### 13. Automatic Fancy Settlement (Cron Job)
**Description:** Automatically runs every 15 seconds to settle fancy bets based on results from the CricketId API.

**Trigger:** Automatic (Cron: `*/15 * * * * *`)

**Process:**
1. Fetches fancy results from CricketId API
2. Checks for declared or cancelled fancies
3. Settles all pending bets for those fancies
4. Updates wallet balances
5. Recalculates user P/L

**Settlement ID Format:** `CRICKET:FANCY:{eventId}:{selectionId}`

---

## 📊 Settlement Types

### Market Types
- **FANCY**: Fancy market bets (auto-settled)
- **BOOKMAKER**: Bookmaker market bets (manual settlement)
- **MATCH_ODDS**: Match odds bets (manual settlement)

### Settlement ID Formats
- Fancy: `CRICKET:FANCY:{eventId}:{selectionId}`
- Bookmaker: `CRICKET:BOOKMAKER:{eventId}:{marketId}`
- Match Odds: `CRICKET:MATCHODDS:{eventId}:{marketId}`

---

## 🔄 Settlement Flow

### Manual Settlement Flow:
1. Admin calls settlement endpoint with event/market/winner details
2. System checks if settlement already exists
3. Finds all pending bets for that settlement
4. Calculates win/loss for each bet
5. Updates bet status and P/L
6. Updates user wallet balances
7. Recalculates user P/L for the event
8. Creates/updates settlement record

### Automatic Settlement Flow (Fancy):
1. Cron job runs every 15 seconds
2. Fetches fancy results from CricketId API
3. For each declared/cancelled fancy:
   - Finds pending bets
   - Calculates outcomes (BACK/LAY logic)
   - Updates bets and wallets
   - Recalculates P/L

---

## ⚠️ Important Notes

1. **Double Settlement Prevention**: The system checks if a settlement already exists before processing
2. **Rollback Support**: Settlements can be rolled back, which reverses all changes
3. **P/L Recalculation**: After settlement, user P/L is automatically recalculated
4. **Transaction Safety**: All wallet updates are done in transactions for data integrity
5. **Settlement Record**: A settlement record is created/updated in the database for audit purposes

---

## 📝 Error Responses

### 404 Not Found
```json
{
  "message": "Cannot GET /settlement/bets/me/pending",
  "error": "Not Found",
  "statusCode": 404
}
```
**Solution:** Ensure the endpoint is correctly implemented (now fixed ✅)

### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": "Settlement CRICKET:MATCHODDS:34917574:1.250049502 already exists"
}
```

### 401 Unauthorized
```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

### 403 Forbidden
```json
{
  "statusCode": 403,
  "message": "Forbidden resource"
}
```
**Note:** Admin endpoints require ADMIN or SUPER_ADMIN role

