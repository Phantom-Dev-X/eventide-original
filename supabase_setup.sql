-- ─────────────────────────────────────────────────────────────
-- ⚡ UPGRADED SCHEMA: MULTI-PERSONA SINGLE-ROW PACKAGED SYNC
-- ─────────────────────────────────────────────────────────────
-- Run this SQL in your Supabase SQL Editor to configure your database.
-- It handles the new 'persona' column for multi-persona switching natively.

-- 1. DROP THE OLD FILE JARGON TABLE (IF PRESENT)
DROP TABLE IF EXISTS whatsapp_sessions CASCADE;

-- 2. CREATE THE ULTRA-CLEAN PACKAGED SESSIONS TABLE
CREATE TABLE whatsapp_sessions (
    phone_number TEXT PRIMARY KEY,
    session_files JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and add administrative access
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service_role full access to whatsapp_sessions" 
ON whatsapp_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. CREATE THE USER MAPPINGS TABLE WITH MULTI-PERSONA SUPPORT
CREATE TABLE IF NOT EXISTS whatsapp_users (
    chat_id BIGINT NOT NULL PRIMARY KEY,
    phone_number TEXT,
    status TEXT NOT NULL DEFAULT 'disconnected',
    persona TEXT NOT NULL DEFAULT 'eclipse', -- Persists the active bot persona ('eclipse', 'astraea', 'vim')
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- NOTE: If your 'whatsapp_users' table already exists, run this single line to add the persona column:
ALTER TABLE whatsapp_users ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT 'eclipse';

-- Enable RLS and add administrative access for users mapping
ALTER TABLE whatsapp_users ENABLE ROW LEVEL SECURITY;

-- If policy doesn't exist, create it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'whatsapp_users' AND policyname = 'Allow service_role full access to whatsapp_users'
    ) THEN
        CREATE POLICY "Allow service_role full access to whatsapp_users" 
        ON whatsapp_users FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

-- 4. CREATE CLEAN INDEXES
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_phone_number ON whatsapp_sessions(phone_number);
CREATE INDEX IF NOT EXISTS idx_whatsapp_users_phone_number ON whatsapp_users(phone_number);
