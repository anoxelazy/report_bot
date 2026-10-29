// ย้ายข้อมูลเดิม (SQLite + โฟลเดอร์ uploads) ขึ้น Supabase
// รัน: node --env-file=.env scripts/migrate-to-supabase.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { insertPhoto, uploadFile } from '../src/db.js';

const DB_FILE = 'data/photos.db';
if (!existsSync(DB_FILE)) {
  console.log('ไม่พบ data/photos.db ไม่มีอะไรให้ย้าย');
  process.exit(0);
}

const rows = new DatabaseSync(DB_FILE).prepare('SELECT * FROM photos ORDER BY id').all();
const mime = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
};
let moved = 0;
let skipped = 0;
let failed = 0;

for (const r of rows) {
  const file = path.join('uploads', r.file_path);
  try {
    if (!existsSync(file)) throw new Error('ไม่พบไฟล์ในเครื่อง');
    await uploadFile(r.file_path, readFileSync(file), mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    const { changes } = await insertPhoto({
      messageId: r.message_id, attachmentId: r.attachment_id, channelId: r.channel_id,
      userId: r.user_id, username: r.username, caption: r.caption,
      filePath: r.file_path, takenAt: r.taken_at, month: r.month, day: r.day,
    });
    if (changes) moved++; else skipped++;
  } catch (err) {
    failed++;
    console.error(`ย้ายไม่สำเร็จ id=${r.id} (${r.file_path}):`, err.message);
  }
}
console.log(`เสร็จสิ้น: ย้าย ${moved} รูป, มีอยู่แล้ว ${skipped}, ล้มเหลว ${failed} (จากทั้งหมด ${rows.length})`);
if (!failed) console.log('ตรวจสอบบน dashboard แล้ว จึงลบโฟลเดอร์ uploads/ และ data/ ในเครื่องได้เพื่อคืนพื้นที่');
