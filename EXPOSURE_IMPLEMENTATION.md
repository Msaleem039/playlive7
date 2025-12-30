# Betting Exposure Implementation

## Overview

This implementation provides real-time betting exposure (profit/loss) calculation per selection for markets. Exposure is calculated immediately when bets are placed, with no WebSocket, cron jobs, or frontend loops required.

## Architecture

### Files Created

1. **`src/exposure/exposure.service.ts`** - Core exposure calculation logic
2. **`src/exposure/exposure.controller.ts`** - API endpoint for fetching exposure
3. **`src/exposure/exposure.module.ts`** - NestJS module configuration

### Integration Points

- **`src/bets/bets.service.ts`** - Automatically calculates exposure after bet placement
- **`src/bets/bets.module.ts`** - Imports ExposureModule
- **`src/app.module.ts`** - Registers ExposureModule

## API Endpoints

### GET `/markets/:marketId/exposure`

Get exposure (profit/loss) per selection for a specific market.

**Query Parameters:**
- `userId` (optional) - Filter exposure for specific user

**Example Request:**
```bash
GET /markets/1.250049502/exposure
GET /markets/1.250049502/exposure?userId=user123
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "marketId": "1.250049502",
    "selections": [
      {
        "selection": "Melbourne Stars",
        "selectionId": 12345,
        "pnl": 1075.50,
        "backStake": 1000,
        "layStake": 500,
        "backOdds": 2.5,
        "layOdds": 2.3
      },
      {
        "selection": "Hobart Hurricanes",
        "selectionId": 12346,
        "pnl": -500.00,
        "backStake": 0,
        "layStake": 1000,
        "backOdds": 0,
        "layOdds": 1.8
      }
    ],
    "totalExposure": 575.50
  }
}
```

## Business Logic

### P&L Calculation Rules

**BACK Bet:**
- If selection wins: Profit = `stake * (odds - 1)`
- If selection loses: Loss = `-stake`

**LAY Bet:**
- If selection wins: Loss = `-stake * (odds - 1)`
- If selection loses: Profit = `stake`

### Exposure Calculation

For each selection in a market, the exposure shows:
- **P&L if THIS selection wins** (considering all bets in the market)
- This includes:
  - Bets on this selection (what happens if it wins)
  - Bets on other selections (what happens to those if this wins - they lose)

### Example Scenario

**Market:** Match Odds
**Bets:**
- BACK 1000 on "Melbourne Stars" at odds 2.5
- BACK 500 on "Hobart Hurricanes" at odds 3.0
- LAY 500 on "Melbourne Stars" at odds 2.3

**Exposure if "Melbourne Stars" wins:**
- BACK on Stars: +1000 * (2.5 - 1) = +1500
- BACK on Hurricanes: -500 (loses)
- LAY on Stars: -500 * (2.3 - 1) = -650
- **Total P&L = 1500 - 500 - 650 = 350**

**Exposure if "Hobart Hurricanes" wins:**
- BACK on Stars: -1000 (loses)
- BACK on Hurricanes: +500 * (3.0 - 1) = +1000
- LAY on Stars: +500 (wins)
- **Total P&L = -1000 + 1000 + 500 = 500**

## Automatic Calculation

Exposure is automatically calculated and included in the bet placement response:

**POST `/bf_placeBet_api`**

After a bet is successfully placed, the response includes exposure data:

```json
{
  "success": true,
  "debug": {
    "bet_id": "bet123",
    "exposure": {
      "marketId": "1.250049502",
      "selections": [...],
      "totalExposure": 575.50
    }
  },
  "remaining_credit": 1500
}
```

## Performance Considerations

- Uses indexed Prisma queries for efficient data retrieval
- Only fetches pending bets (status = PENDING)
- Calculations are performed in-memory (no database writes for exposure)
- Non-blocking: If exposure calculation fails, bet placement still succeeds

## Database Schema

No schema changes required. Uses existing `Bet` model with:
- `marketId` - Market identifier
- `selectionId` - Selection/team identifier
- `betType` - BACK or LAY
- `betValue` - Stake amount
- `betRate` - Odds
- `betName` - Selection name
- `status` - Bet status (only PENDING bets are included)

## Testing Scenarios

1. **Single BACK bet** - Should show positive P&L for that selection
2. **Single LAY bet** - Should show negative P&L for that selection
3. **Perfect hedge (BACK + LAY same amount)** - Should show ~0 P&L
4. **Multiple selections** - Should show P&L for each selection
5. **User-specific exposure** - Should only show bets for that user

## Error Handling

- Invalid marketId returns 400 Bad Request
- Exposure calculation errors are logged but don't fail bet placement
- API errors return proper HTTP status codes with error details

