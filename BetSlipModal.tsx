'use client'

import { useState, useEffect } from 'react'
import { usePlaceBetMutation } from '@/app/services/Api'
import { toast } from 'sonner'

interface SelectedBet {
  team: string
  type: 'back' | 'lay'
  odds: string
  market: string
  selectionId?: number
  marketId?: number
  marketGType?: string
}

interface BetSlipModalProps {
  isOpen: boolean
  selectedBet: SelectedBet | null
  onClose: () => void
  onClear: () => void
  matchId: number | null
  authUser: any
  onBetPlaced?: () => void
  isMobile?: boolean
}

export default function BetSlipModal({
  isOpen,
  selectedBet,
  onClose,
  onClear,
  matchId,
  authUser,
  onBetPlaced,
  isMobile = false
}: BetSlipModalProps) {
  const [stake, setStake] = useState<string>('')
  const [odds, setOdds] = useState<string>('')
  const [placeBet, { isLoading: isPlacingBet }] = usePlaceBetMutation()

  // Update odds when selectedBet changes
  useEffect(() => {
    if (selectedBet) {
      setOdds(selectedBet.odds)
      setStake('')
    }
  }, [selectedBet])

  if (!isOpen || !selectedBet) return null

  /**
   * Calculate profit/loss based on market type and bet type
   * This matches the backend logic in bets.service.ts
   */
  const calculateProfitLoss = (
    stakeValue: number,
    oddsValue: number,
    betType: 'back' | 'lay',
    gtype: string
  ): { winAmount: number; lossAmount: number; plText: string } => {
    // Check market type
    const isFancyBet = gtype === 'fancy' || gtype === 'fancy1' || gtype === 'fancy2'
    const isMatchOdds = gtype === 'match_odds' || gtype === 'match'
    const isBookmaker = gtype === 'bookmaker' || gtype === 'bookmatch'
    const isOddeven = gtype === 'oddeven'

    let winAmount = 0
    let lossAmount = 0

    if (isFancyBet) {
      // For fancy bets: odds might be in different format
      // If odds >= 100, it might be in "points" format (e.g., 99 = 99 points)
      // Otherwise, treat as standard decimal odds
      // Based on user feedback: "on 500 you got 500 market value" - suggests 1:1 or odds represent multiplier
      
      if (oddsValue >= 100) {
        // Fancy bets with high odds: might be points-based (1:1 ratio)
        // If you bet 500 at odds 99, you get 500 (1:1) or 500 * (99/100) = 495
        // For now, using 1:1 calculation for fancy bets with high odds
        if (betType === 'back') {
          winAmount = stakeValue // 1:1 profit
          lossAmount = stakeValue // Stake at risk
        } else {
          // Lay: you receive stake if win, pay stake if lose
          winAmount = stakeValue
          lossAmount = stakeValue
        }
      } else {
        // Fancy bets with decimal odds: use standard calculation
        if (betType === 'back') {
          winAmount = stakeValue * (oddsValue - 1) // Profit
          lossAmount = stakeValue // Stake at risk
        } else {
          // Lay: receive stake if win, pay profit if lose
          winAmount = stakeValue // Stake received
          lossAmount = stakeValue * (oddsValue - 1) // Profit paid if lose
        }
      }
    } else if (isMatchOdds || isBookmaker || isOddeven) {
      // Standard market calculation
      if (betType === 'back') {
        // BACK bet:
        // - If win: get stake * odds (total return), profit = stake * (odds - 1)
        // - If lose: lose stake
        winAmount = stakeValue * (oddsValue - 1) // Profit if win
        lossAmount = stakeValue // Stake at risk
      } else {
        // LAY bet:
        // - If win: receive stake from backer
        // - If lose: pay profit to backer = stake * (odds - 1)
        winAmount = stakeValue // Stake received if win
        lossAmount = stakeValue * (oddsValue - 1) // Profit paid if lose
      }
    } else {
      // Default/unknown market type: use standard calculation
      if (betType === 'back') {
        winAmount = stakeValue * (oddsValue - 1)
        lossAmount = stakeValue
      } else {
        winAmount = stakeValue
        lossAmount = stakeValue * (oddsValue - 1)
      }
    }

    // Format P/L text: "Profit / Loss"
    const plText = `${winAmount.toFixed(2)} / ${lossAmount.toFixed(2)}`

    return { winAmount, lossAmount, plText }
  }

  const stakeValue = parseFloat(stake)
  const oddsValue = parseFloat(odds || selectedBet.odds)
  let plText = '0 / 0'
  
  if (!isNaN(stakeValue) && stakeValue > 0 && !isNaN(oddsValue) && oddsValue > 0) {
    const result = calculateProfitLoss(
      stakeValue,
      oddsValue,
      selectedBet.type,
      selectedBet.marketGType || 'match_odds'
    )
    plText = result.plText
  }

  const handlePlaceBet = async () => {
    if (!selectedBet) {
      toast.error('Please select a bet first.')
      return
    }

    const betStake = parseFloat(stake)
    if (isNaN(betStake) || betStake <= 0) {
      toast.error('Please enter a valid stake amount.')
      return
    }

    const betRate = parseFloat(odds || selectedBet.odds)
    if (isNaN(betRate) || betRate <= 0) {
      toast.error('Invalid odds value.')
      return
    }

    // Calculate win_amount and loss_amount based on market type
    const { winAmount, lossAmount } = calculateProfitLoss(
      betStake,
      betRate,
      selectedBet.type,
      selectedBet.marketGType || 'match_odds'
    )

    const betType = selectedBet.type === 'back' ? 'BACK' : 'LAY'

    // Try multiple user ID fields - backend expects string user_id
    const userId = 
      (authUser as any)?.user_id ??           // Try user_id first (if backend uses this)
      (authUser as any)?.userId ??             // Try userId
      (authUser as any)?.id ??                 // Try id (convert to string)
      (authUser as any)?.numericId ??          // Try numericId if exists
      null

    if (!userId) {
      toast.error('User ID not found. Please login again.')
      return
    }

    // Log user ID for debugging
    console.log('Bet placement - User ID fields:', {
      user_id: (authUser as any)?.user_id,
      userId: (authUser as any)?.userId,
      id: (authUser as any)?.id,
      numericId: (authUser as any)?.numericId,
      selectedUserId: userId,
      fullUser: authUser
    })

    const payload = {
      selection_id: selectedBet.selectionId ?? 0,
      bet_type: betType,
      user_id: String(userId), // Ensure it's a string
      bet_name: selectedBet.team,
      bet_rate: betRate,
      match_id: matchId ?? 0,
      market_name: selectedBet.market,
      betvalue: betStake,
      market_type: 'in_play',
      win_amount: Number(winAmount.toFixed(2)),
      loss_amount: Number(lossAmount.toFixed(2)),
      gtype: selectedBet.marketGType || 'match_odds',
      runner_name_2: '',
    }

    console.log('Placing bet with payload:', payload)

    try {
      const data = await placeBet(payload).unwrap()
      console.log('Bet placed successfully:', data)
      toast.success('Bet placed successfully.')
      onClose()
      setStake('')
      onClear()
      // Call callback to refetch pending bets
      if (onBetPlaced) {
        onBetPlaced()
      }
    } catch (error: any) {
      console.error('Error placing bet:', error)
      
      // Show specific error message from backend
      const errorMessage = 
        error?.data?.error || 
        error?.data?.message || 
        error?.message || 
        'Failed to place bet. Please try again.'
      
      toast.error(errorMessage)
      
      // If user not found, suggest checking user ID
      if (error?.data?.code === 'USER_NOT_FOUND' || errorMessage.includes('User not found')) {
        console.error('User ID issue - Current user:', {
          userId: userId,
          userObject: authUser,
          availableFields: Object.keys(authUser || {})
        })
      }
    }
  }

  const handleClear = () => {
    setStake('')
    onClear()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40">
      <div className="w-full max-w-md mx-2 sm:mx-4 mb-2 sm:mb-0" onClick={(e) => e.stopPropagation()}>
        <div
          className="bg-pink-50 border-t border-gray-200 flex flex-col rounded-t-lg sm:rounded-lg overflow-hidden shadow-xl"
          style={{ maxHeight: isMobile ? '360px' : '420px' }}
        >
          <div className="bg-gray-800 text-white px-3 sm:px-4 py-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Bet Slip</span>
            <span className="text-xs text-gray-300 cursor-pointer hover:text-white">Edit Stakes</span>
          </div>

          <div className="p-3 sm:p-4 space-y-3 overflow-y-auto">
            <div className="grid grid-cols-4 gap-1 sm:gap-2 text-xs font-semibold text-gray-700">
              <div className="bg-gray-200 px-1 sm:px-2 py-1 rounded text-center sm:text-left">Bet for</div>
              <div className="bg-gray-200 px-1 sm:px-2 py-1 rounded text-center">Odds</div>
              <div className="bg-gray-200 px-1 sm:px-2 py-1 rounded text-center">Stake</div>
              <div className="bg-gray-200 px-1 sm:px-2 py-1 rounded text-center">P/L</div>
            </div>

            <div className="grid grid-cols-4 gap-1 sm:gap-2 items-center">
              <div className="text-xs sm:text-sm font-medium text-gray-900 truncate text-center sm:text-left">
                {selectedBet.team}
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={odds}
                  onChange={(e) => setOdds(e.target.value)}
                  className="w-full px-1 sm:px-2 py-1 text-xs sm:text-sm border border-gray-300 rounded"
                />
                <div className="flex flex-col">
                  <button className="text-xs">▲</button>
                  <button className="text-xs">▼</button>
                </div>
              </div>
              <div>
                <input
                  type="text"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  placeholder="Stake"
                  className="w-full px-1 sm:px-2 py-1 text-xs sm:text-sm border border-gray-300 rounded"
                />
              </div>
              <div className="text-xs sm:text-sm text-gray-700 text-center">{plText}</div>
            </div>

            <div className="grid grid-cols-4 gap-1 sm:gap-2">
              {[100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((amount) => (
                <button
                  key={amount}
                  onClick={() => setStake(amount.toString())}
                  className="bg-pink-500 hover:bg-pink-600 text-white px-1 sm:px-3 py-1 sm:py-2 rounded text-xs sm:text-sm font-medium"
                >
                  {isMobile && amount >= 1000 ? `${amount / 1000}k` : amount.toLocaleString()}
                </button>
              ))}
            </div>

            <div className="flex gap-1 sm:gap-2 pt-2">
              <button
                onClick={onClose}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white px-2 sm:px-4 py-2 rounded text-xs sm:text-sm font-semibold"
              >
                Close
              </button>
              <button
                onClick={handleClear}
                className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white px-2 sm:px-4 py-2 rounded text-xs sm:text-sm font-semibold"
              >
                Clear
              </button>
              <button
                onClick={handlePlaceBet}
                disabled={isPlacingBet}
                className="flex-1 bg-[#00A66E] hover:bg-[#008a5a] text-white px-2 sm:px-4 py-2 rounded text-xs sm:text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPlacingBet ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

