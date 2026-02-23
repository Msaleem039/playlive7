-- Check what columns exist in the bets table related to isRangeConsumed
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'bets' 
AND (column_name LIKE '%range%' OR column_name LIKE '%Range%' OR column_name LIKE '%RANGE%')
ORDER BY column_name;






