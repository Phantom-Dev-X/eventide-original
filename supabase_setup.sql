-- ─────────────────────────────────────────────────────────────
-- ⚡ SUPABASE DATABASE SCHEMA FOR EVENTIDE-ORIGINAL MULTI-BOT
-- ─────────────────────────────────────────────────────────────
-- Run this SQL script in your Supabase SQL Editor to set up the 
-- necessary tables for session persistence and user mapping.

-- 1. Create the WhatsApp Sessions Table (stores session files)
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    phone_number TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_content TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (phone_number, file_path)
);

-- Enable Row Level Security (RLS) or add indexes
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

-- Create an open policy for convenience (or customize to restrict access to authenticated roles)
CREATE POLICY "Allow service_role full access to whatsapp_sessions" 
ON whatsapp_sessions 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

-- 2. Create the WhatsApp Users Table (stores Telegram-to-WhatsApp mappings)
CREATE TABLE IF NOT EXISTS whatsapp_users (
    chat_id BIGINT NOT NULL PRIMARY KEY,
    phone_number TEXT,
    status TEXT NOT NULL DEFAULT 'disconnected',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS) for whatsapp_users
ALTER TABLE whatsapp_users ENABLE ROW LEVEL SECURITY;

-- Create an open policy for service_role
CREATE POLICY "Allow service_role full access to whatsapp_users" 
ON whatsapp_users 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

-- Add helpful indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_phone_number ON whatsapp_sessions(phone_number);
CREATE INDEX IF NOT EXISTS idx_whatsapp_users_phone_number ON whatsapp_users(phone_number);
