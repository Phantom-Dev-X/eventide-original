import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

// Ensure global WebSocket is available for newer @supabase/supabase-js in Node.js environments
if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = WebSocket;
}

// ──────────────────────────────────────────────
// 📋 CONFIG & INITIALIZATION
// ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: {
                persistSession: false
            }
        });
        console.log('[SUPABASE] Service initialized successfully.');
    } catch (err) {
        console.error('[SUPABASE] Failed to create Supabase client:', err.message);
    }
} else {
    console.log('[SUPABASE] Environment variables SUPABASE_URL and/or SUPABASE_KEY not set. Supabase sync is disabled.');
}

// Map to store per-phone-number debounce timers for syncing
const syncTimers = new Map();

/**
 * Checks if Supabase integration is enabled and configured.
 * @returns {boolean}
 */
export function isSupabaseEnabled() {
    return !!supabase;
}

// ──────────────────────────────────────────────
// 📂 SESSION OPERATIONS (SINGLE-ROW PACKAGED SYNC)
// ──────────────────────────────────────────────

/**
 * Downloads the entire packaged session for a phone number from Supabase and extracts it locally.
 * This query is ultra-fast as it retrieves exactly one row by primary key.
 * @param {string} phoneNumber - The target WhatsApp phone number.
 * @param {string} targetDir - The local directory where session files should be saved.
 * @returns {Promise<boolean>} True if restored successfully, false otherwise.
 */
export async function downloadSessionFromSupabase(phoneNumber, targetDir) {
    if (!supabase) return false;
    try {
        console.log(`[SUPABASE] Fetching packaged session for ${phoneNumber}...`);
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('session_files')
            .eq('phone_number', phoneNumber)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                console.log(`[SUPABASE] No existing session row found for ${phoneNumber} in database.`);
            } else {
                console.error(`[SUPABASE] Error downloading session for ${phoneNumber}:`, error.message);
            }
            return false;
        }

        if (!data || !data.session_files) {
            console.log(`[SUPABASE] Session row for ${phoneNumber} is empty.`);
            return false;
        }

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const filesMap = data.session_files;
        const fileNames = Object.keys(filesMap);

        for (const fileName of fileNames) {
            const fullPath = path.join(targetDir, fileName);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, filesMap[fileName], 'utf8');
        }

        console.log(`[SUPABASE] Successfully restored ${fileNames.length} files from a single row for ${phoneNumber}.`);
        return true;
    } catch (err) {
        console.error(`[SUPABASE] Unexpected error restoring session for ${phoneNumber}:`, err);
        return false;
    }
}

/**
 * Packages all local session files into a single JSON object and uploads it to Supabase in one atomic row.
 * Eliminates "table jargon" (hundreds of rows of pre-keys) and avoids partial sync corruption.
 * @param {string} phoneNumber - The WhatsApp phone number.
 * @param {string} localDir - The local directory of the session.
 */
export async function syncLocalToSupabase(phoneNumber, localDir) {
    if (!supabase) return;
    try {
        if (!fs.existsSync(localDir)) {
            console.log(`[SUPABASE] Local directory ${localDir} does not exist, skipping sync.`);
            return;
        }

        // 1. Read all local files and build a single packaged object
        const localFiles = fs.readdirSync(localDir).filter(name => {
            const full = path.join(localDir, name);
            try { return fs.statSync(full).isFile(); }
            catch { return false; }
        });

        const sessionFiles = {};
        for (const name of localFiles) {
            try {
                const content = fs.readFileSync(path.join(localDir, name), 'utf8');
                sessionFiles[name] = content;
            } catch (err) {
                console.error(`[SUPABASE] Error reading local file ${name} for packaging:`, err.message);
            }
        }

        const fileCount = Object.keys(sessionFiles).length;
        if (fileCount === 0) {
            console.log(`[SUPABASE] No local files found to sync for ${phoneNumber}.`);
            return;
        }

        console.log(`[SUPABASE] Packaging and uploading ${fileCount} files in a single row for ${phoneNumber}...`);

        // 2. Perform atomic single-row upsert
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({
                phone_number: phoneNumber,
                session_files: sessionFiles,
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone_number' });

        if (error) {
            console.error(`[SUPABASE] Error upserting packaged session for ${phoneNumber}:`, error.message);
        } else {
            console.log(`[SUPABASE] Successfully synced all ${fileCount} files to Supabase in a single row for ${phoneNumber}!`);
        }

    } catch (err) {
        console.error(`[SUPABASE] Unexpected error in syncLocalToSupabase for ${phoneNumber}:`, err);
    }
}

/**
 * Triggers a debounced sync of local session files to Supabase.
 * Keeps write operations efficient and avoids hitting Supabase rate limits during session init.
 * @param {string} phoneNumber - The WhatsApp phone number.
 * @param {string} localDir - The local directory of the session.
 * @param {number} delayMs - Debounce delay in milliseconds (default 3000ms).
 */
export function debouncedSyncLocalToSupabase(phoneNumber, localDir, delayMs = 3000) {
    if (!supabase) return;

    if (syncTimers.has(phoneNumber)) {
        clearTimeout(syncTimers.get(phoneNumber));
    }

    const timer = setTimeout(async () => {
        syncTimers.delete(phoneNumber);
        console.log(`[SUPABASE] Debounced single-row sync triggered for ${phoneNumber}...`);
        await syncLocalToSupabase(phoneNumber, localDir);
    }, delayMs);

    syncTimers.set(phoneNumber, timer);
}

/**
 * Deletes the single session row of a phone number from Supabase.
 * @param {string} phoneNumber - The phone number whose session is being deleted.
 */
export async function deleteSessionFromSupabase(phoneNumber) {
    if (!supabase) return;
    try {
        console.log(`[SUPABASE] Deleting packaged session row for ${phoneNumber} from database...`);
        const { error } = await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('phone_number', phoneNumber);

        if (error) {
            console.error(`[SUPABASE] Error deleting session row for ${phoneNumber}:`, error.message);
        } else {
            console.log(`[SUPABASE] Successfully deleted session row for ${phoneNumber}.`);
        }
    } catch (err) {
        console.error(`[SUPABASE] Unexpected error deleting session for ${phoneNumber}:`, err);
    }
}

/**
 * Fetches all phone numbers that have saved session files in Supabase.
 * @returns {Promise<string[]>} Array of phone numbers.
 */
export async function getAllSessionPhoneNumbers() {
    if (!supabase) return [];
    try {
        console.log('[SUPABASE] Fetching all registered phone numbers with saved sessions...');
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('phone_number');

        if (error) {
            console.error('[SUPABASE] Error fetching session phone numbers:', error.message);
            return [];
        }

        const phoneNumbers = data.map(item => item.phone_number);
        console.log(`[SUPABASE] Found ${phoneNumbers.length} session row(s) in database:`, phoneNumbers);
        return phoneNumbers;
    } catch (err) {
        console.error('[SUPABASE] Unexpected error getting session phone numbers:', err);
        return [];
    }
}

// ──────────────────────────────────────────────
// 👤 USER MAPPING OPERATIONS (MULTIPLE PERSONAS)
// ──────────────────────────────────────────────

/**
 * Saves or updates a user mapping in the whatsapp_users table.
 * @param {number} chatId - Telegram chat ID.
 * @param {string|null} phoneNumber - Associated WhatsApp phone number.
 * @param {string} status - Current session/pairing status.
 * @param {string} persona - Currently active bot persona ('eclipse', 'astraea', 'vim').
 */
export async function saveUserToSupabase(chatId, phoneNumber, status, persona = 'eclipse') {
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from('whatsapp_users')
            .upsert({
                chat_id: chatId,
                phone_number: phoneNumber,
                status: status || 'disconnected',
                persona: persona,
                updated_at: new Date().toISOString()
            }, { onConflict: 'chat_id' });

        if (error) {
            console.error(`[SUPABASE] Error saving user ${chatId}:`, error.message);
        } else {
            console.log(`[SUPABASE] Saved user mapping to Supabase: Chat ID ${chatId} -> ${phoneNumber} (${status}, persona: ${persona})`);
        }
    } catch (err) {
        console.error(`[SUPABASE] Unexpected error saving user ${chatId}:`, err);
    }
}

/**
 * Deletes a user mapping from the whatsapp_users table.
 * @param {number} chatId - Telegram chat ID.
 */
export async function deleteUserFromSupabase(chatId) {
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from('whatsapp_users')
            .delete()
            .eq('chat_id', chatId);

        if (error) {
            console.error(`[SUPABASE] Error deleting user ${chatId}:`, error.message);
        } else {
            console.log(`[SUPABASE] Deleted user mapping from Supabase: Chat ID ${chatId}`);
        }
    } catch (err) {
        console.error(`[SUPABASE] Unexpected error deleting user ${chatId}:`, err);
    }
}

/**
 * Loads all user mappings from the whatsapp_users table.
 * Uses select('*') to dynamically handle the presence of the 'persona' column safely.
 * @returns {Promise<object|null>} Object resembling the contents of user_map.json, or null if disabled/failed.
 */
export async function loadAllUsersFromSupabase() {
    if (!supabase) return null;
    try {
        console.log('[SUPABASE] Loading all user mappings from database...');
        const { data, error } = await supabase
            .from('whatsapp_users')
            .select('*');

        if (error) {
            console.error('[SUPABASE] Error fetching user mappings:', error.message);
            return null;
        }

        const map = {};
        if (data) {
            for (const user of data) {
                map[String(user.chat_id)] = {
                    phoneNumber: user.phone_number,
                    status: user.status || 'disconnected',
                    persona: user.persona || 'eclipse' // Fallback to 'eclipse' if not present
                };
            }
        }
        console.log(`[SUPABASE] Loaded ${Object.keys(map).length} user mapping(s) from Supabase.`);
        return map;
    } catch (err) {
        console.error('[SUPABASE] Unexpected error loading users:', err);
        return null;
    }
}
