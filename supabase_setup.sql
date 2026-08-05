-- ─────────────────────────────────────────────────────────────
-- ⚡ UPGRADED SCHEMA: SINGLE-ROW PACKAGED SYNC FOR EVENTIDE-ORIGINAL
-- ─────────────────────────────────────────────────────────────
-- Run this SQL in your Supabase SQL Editor to wipe out the old 
-- file-by-file "jargon" structure and replace it with the ultra-clean, 
-- single-row-per-user JSONB schema!

-- 1. DROP THE OLD JARGON SESSIONS TABLE
DROP TABLE IF EXISTS whatsapp_sessions CASCADE;

-- 2. CREATE THE ULTRA-CLEAN PACKAGED SESSIONS TABLE
-- Each phone number will have EXACTLY ONE ROW here! No matter how many files Baileys creates.
CREATE TABLE whatsapp_sessions (
    phone_number TEXT PRIMARY KEY,
    session_files JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and add full administrative access
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service_role full access to whatsapp_sessions" 
ON whatsapp_sessions 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

-- 3. ENSURE USER MAPPING TABLE EXISTS (No changes needed, but runs for safety)
CREATE TABLE IF NOT EXISTS whatsapp_users (
    chat_id BIGINT NOT NULL PRIMARY KEY,
    phone_number TEXT,
    status TEXT NOT NULL DEFAULT 'disconnected',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and add full administrative access for users mapping
ALTER TABLE whatsapp_users ENABLE ROW LEVEL SECURITY;

-- If policy doesn't exist, create it (wrapped in a try block or handled gracefully)
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
