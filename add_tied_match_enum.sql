DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_enum 
        WHERE enumlabel = 'TIED_MATCH' 
        AND enumtypid = (
            SELECT oid 
            FROM pg_type 
            WHERE typname = 'market_type'
        )
    ) THEN
        ALTER TYPE market_type ADD VALUE 'TIED_MATCH';
        RAISE NOTICE 'TIED_MATCH added to market_type enum';
    ELSE
        RAISE NOTICE 'TIED_MATCH already exists in market_type enum';
    END IF;
END $$;

