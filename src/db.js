import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  throw new Error('ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_KEY ใน .env (ดู .env.example)');
}

// ใช้ service key ฝั่งเซิร์ฟเวอร์เท่านั้น ห้ามส่งไปที่หน้าเว็บ
export const supabase = createClient(url, key, { auth: { persistSession: false } });
export const BUCKET = 'photos';

const SIGNED_URL_TTL = 60 * 60; // ลิงก์รูปในหน้า dashboard มีอายุ 1 ชม.
const PAGE = 1000; // Supabase คืนสูงสุด 1000 แถวต่อครั้ง

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

export async function uploadFile(filePath, buffer, contentType) {
  check(await supabase.storage.from(BUCKET).upload(filePath, buffer, { contentType, upsert: true }));
}

export async function downloadFile(filePath) {
  const blob = check(await supabase.storage.from(BUCKET).download(filePath));
  return Buffer.from(await blob.arrayBuffer());
}

// คืน { changes: 1 } เมื่อเพิ่มแถวใหม่ หรือ { changes: 0 } เมื่อรูปนี้มีอยู่แล้ว
export async function insertPhoto(p) {
  const data = check(await supabase.from('photos').upsert({
    message_id: p.messageId, attachment_id: p.attachmentId, channel_id: p.channelId,
    user_id: p.userId, username: p.username, caption: p.caption,
    file_path: p.filePath, taken_at: p.takenAt, month: p.month, day: p.day,
  }, { onConflict: 'attachment_id', ignoreDuplicates: true }).select('id'));
  return { changes: data.length };
}

// 1 งาน = รูปทั้งหมดที่ส่งมาพร้อมกันในครั้งเดียว (message_id เดียวกัน)
export async function listMonths() {
  return check(await supabase.from('month_summary').select('month, jobs, photos').order('month', { ascending: false }));
}

async function monthRows(month) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const data = check(await supabase.from('photos').select('*').eq('month', month)
      .order('taken_at', { ascending: false }).order('id', { ascending: true })
      .range(from, from + PAGE - 1));
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function signUrls(paths) {
  const urls = new Map();
  for (let i = 0; i < paths.length; i += 100) {
    const data = check(await supabase.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 100), SIGNED_URL_TTL));
    for (const d of data) if (d.signedUrl) urls.set(d.path, d.signedUrl);
  }
  return urls;
}

// sign=false เมื่อไม่ต้องใช้ลิงก์รูป (เช่น ส่งออก CSV/Excel/ZIP)
export async function monthReport(month, { sign = true } = {}) {
  const rows = await monthRows(month);

  const jobMap = new Map();
  const dayJobs = new Map(); // day -> Set(message_id)
  const userStats = new Map(); // user_id -> { username, jobs:Set, photos }
  for (const p of rows) {
    let job = jobMap.get(p.message_id);
    if (!job) {
      job = { id: p.message_id, caption: p.caption, username: p.username, taken_at: p.taken_at, photos: [] };
      jobMap.set(p.message_id, job);
    }
    job.photos.push({ id: p.id, file_path: p.file_path });

    if (!dayJobs.has(p.day)) dayJobs.set(p.day, new Set());
    dayJobs.get(p.day).add(p.message_id);

    let u = userStats.get(p.user_id);
    if (!u) userStats.set(p.user_id, (u = { username: p.username, jobs: new Set(), photos: 0 }));
    u.jobs.add(p.message_id);
    u.photos++;
  }

  if (sign) {
    const urls = await signUrls(rows.map((p) => p.file_path));
    for (const job of jobMap.values()) for (const ph of job.photos) ph.url = urls.get(ph.file_path) ?? '';
  }

  return {
    month,
    totalJobs: jobMap.size,
    totalPhotos: rows.length,
    byDay: [...dayJobs].map(([day, s]) => ({ day, count: s.size })).sort((a, b) => a.day.localeCompare(b.day)),
    byUser: [...userStats.values()]
      .map((u) => ({ username: u.username, jobs: u.jobs.size, photos: u.photos }))
      .sort((a, b) => b.jobs - a.jobs),
    jobs: [...jobMap.values()],
  };
}
