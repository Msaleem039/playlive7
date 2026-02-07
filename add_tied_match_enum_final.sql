DO $$
BEGIN
    ALTER TYPE market_type ADD VALUE 'TIED_MATCH';
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'TIED_MATCH already exists in market_type enum';
END $$;




