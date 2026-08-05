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
// 📂 SESSION OPERATIONS
// ──────────────────────────────────────────────

/**
 * Downloads all session files for a phone number from Supabase to a local directory.
 * @param {string} phoneNumber - The target WhatsApp phone number.
 * @param {string} targetDir - The local directory where session files should be saved.
 * @returns {Promise<boolean>} True if restored successfully, false otherwise.
 */
export async function downloadSessionFromSupabase(phoneNumber, targetDir) {
    if (!supabase) return false;
    try {
        console.log(`[SUPABASE] Fetching session files for ${phoneNumber}...`);
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('file_path, file_content')
            .eq('phone_number', phoneNumber);

        if (error) {
            console.error(`[SUPABASE] Error downloading session for ${phoneNumber}:`, error.message);
            return false;
        }

        if (!data || data.length === 0) {
            console.log(`[SUPABASE] No session files found for ${phoneNumber} in database.`);
            return false;
        }

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        for (const file of data) {
            const fullPath = path.join(targetDir, file.file_path);
            // Ensure parent directory exists
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, file.file_content, 'utf8');
        }

        console.log(`[SUPABASE] Successfully restored ${data.length} files for ${phoneNumber} to ${targetDir}`);
        return true;
    } catch (err) {
        console.error(`[SUPABASE] Unexpected error restoring session for ${phoneNumber}:`, err);
        return false;
    }
}

/**
 * Syncs local session files to Supabase:
 * - Upserts new or modified files.
 * - Deletes files from Supabase that no longer exist locally.
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

        // 1. Read all files in the local directory (only files, ignoring directories)
        const localFiles = fs.readdirSync(localDir).filter(name => {
            const full = path.join(localDir, name);
            try { return fs.statSync(full).isFile(); }
            catch { return false; }
        });

        // Map local files to their path and content
        const localFilesMap = new Map();
        for (const name of localFiles) {
            try {
                const content = fs.readFileSync(path.join(localDir, name), 'utf8');
                localFilesMap.set(name, content);
            } catch (err) {
                console.error(`[SUPABASE] Error reading local file ${name}:`, err.message);
            }
        }

        // 2. Fetch remote files info from Supabase for this phone number
        const { data: remoteFiles, error: fetchError } = await supabase
            .from('whatsapp_sessions')
            .select('file_path, file_content')
            .eq('phone_number', phoneNumber);

        if (fetchError) {
            console.error(`[SUPABASE] Error fetching remote files for ${phoneNumber}:`, fetchError.message);
            return;
        }

        const remoteFilesMap = new Map();
        if (remoteFiles) {
            for (const file of remoteFiles) {
                remoteFilesMap.set(file.file_path, file.file_content);
            }
        }

        // 3. Identify files to upsert (new or modified)
        const toUpsert = [];
        for (const [filePath, localContent] of localFilesMap.entries()) {
            const remoteContent = remoteFilesMap.get(filePath);
            if (remoteContent !== localContent) {
                toUpsert.push({
                    phone_number: phoneNumber,
                    file_path: filePath,
                    file_content: localContent,
                    updated_at: new Date().toISOString()
                });
            }
        }

        // 4. Identify files to delete (present in DB but no longer local)
        const toDelete = [];
        for (const remotePath of remoteFilesMap.keys()) {
            if (!localFilesMap.has(remotePath)) {
                toDelete.push(remotePath);
            }
        }

        // 5. Perform upserts
        if (toUpsert.length > 0) {
            console.log(`[SUPABASE] Upserting ${toUpsert.length} files for ${phoneNumber}...`);
            const { error: upsertError } = await supabase
                .from('whatsapp_sessions')
                .upsert(toUpsert, { onConflict: 'phone_number,file_path' });

            if (upsertError) {
                console.error(`[SUPABASE] Error upserting files for ${phoneNumber}:`, upsertError.message);
            } else {
                console.log(`[SUPABASE] Successfully upserted ${toUpsert.length} files for ${phoneNumber}.`);
            }
        }

        // 6. Perform deletions
        if (toDelete.length > 0) {
            console.log(`[SUPABASE] Deleting ${toDelete.length} obsolete files for ${phoneNumber}...`);
            const { error: deleteError = null } = await supabase
                .from('whatsapp_sessions')
                .delete()
                .eq('phone_number', phoneNumber)
                .in('file_path', toDelete) || {};

            if (deleteError) {
                console.error(`[SUPABASE] Error deleting obsolete files for ${phoneNumber}:`, deleteError.message);
            } else {
                console.log(`[SUPABASE] Successfully deleted ${toDelete.length} obsolete files for ${phoneNumber}.`);
            }
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
        console.log(`[SUPABASE] Debounced sync triggered for ${phoneNumber}...`);
        await syncLocalToSupabase(phoneNumber, localDir);
    }, delayMs);

    syncTimers.set(phoneNumber, timer);
}

/**
 * Deletes all files of a session from Supabase.
 * @param {string} phoneNumber - The phone number whose session is being deleted.
 */
export async function deleteSessionFromSupabase(phoneNumber) {
    if (!supabase) return;
    try {
        console.log(`[SUPABASE] Deleting all session files for ${phoneNumber} from database...`);
        const { error } = await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('phone_number', phoneNumber);

        if (error) {
            console.error(`[SUPABASE] Error deleting session files for ${phoneNumber}:`, error.message);
        } else {
            console.log(`[SUPABASE] Successfully deleted all session files for ${phoneNumber}.`);
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
        console.log('[SUPABASE] Fetching all distinct phone numbers with saved sessions...');
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('phone_number');

        if (error) {
            console.error('[SUPABASE] Error fetching session phone numbers:', error.message);
            return [];
        }

        const phoneNumbers = [...new Set(data.map(item => item.phone_number))];
        console.log(`[SUPABASE] Found ${phoneNumbers.length} session(s) in database:`, phoneNumbers);
        return phoneNumbers;
    } catch (err) {
        console.error('[SUPABASE] Unexpected error getting session phone numbers:', err);
        return [];
    }
}

// ──────────────────────────────────────────────
// 👤 USER MAPPING OPERATIONS
// ──────────────────────────────────────────────

/**
 * Saves or updates a user mapping in the whatsapp_users table.
 * @param {number} chatId - Telegram chat ID.
 * @param {string|null} phoneNumber - Associated WhatsApp phone number.
 * @param {string} status - Current session/pairing status.
 */
export async function saveUserToSupabase(chatId, phoneNumber, status) {
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from('whatsapp_users')
            .upsert({
                chat_id: chatId,
                phone_number: phoneNumber,
                status: status || 'disconnected',
                updated_at: new Date().toISOString()
            }, { onConflict: 'chat_id' });

        if (error) {
            console.error(`[SUPABASE] Error saving user ${chatId}:`, error.message);
        } else {
            console.log(`[SUPABASE] Saved user mapping to Supabase: Chat ID ${chatId} -> ${phoneNumber} (${status})`);
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
 * @returns {Promise<object|null>} Object resembling the contents of user_map.json, or null if disabled/failed.
 */
export async function loadAllUsersFromSupabase() {
    if (!supabase) return null;
    try {
        console.log('[SUPABASE] Loading all user mappings from database...');
        const { data, error } = await supabase
            .from('whatsapp_users')
            .select('chat_id, phone_number, status');

        if (error) {
            console.error('[SUPABASE] Error fetching user mappings:', error.message);
            return null;
        }

        const map = {};
        if (data) {
            for (const user of data) {
                map[String(user.chat_id)] = {
                    phoneNumber: user.phone_number,
                    status: user.status || 'disconnected'
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
