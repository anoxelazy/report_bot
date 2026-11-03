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

// ลิงก์ถาวรของรูป (เปิดแล้วเซิร์ฟเวอร์จะออกลิงก์ชั่วคราวให้ใหม่ทุกครั้ง) ใช้ attachment id ของ Discord
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
export const photoLink = (attachmentId) => `${PUBLIC_URL}/p/${attachmentId}`;

// คืนลิงก์ชั่วคราวของรูป หรือ null ถ้าไม่พบ
export async function signedPhotoUrl(attachmentId) {
  const rows = check(await supabase.from('photos').select('file_path').eq('attachment_id', attachmentId).limit(1));
  if (!rows.length) return null;
  return check(await supabase.storage.from(BUCKET).createSignedUrl(rows[0].file_path, 5 * 60)).signedUrl;
}

export async function downloadFile(filePath) {
  const blob = check(await supabase.storage.from(BUCKET).download(filePath));
  return Buffer.from(await blob.arrayBuffer());
}

// คืน id ของเคส (1 ข้อความ Discord = 1 เคส) สร้างใหม่ถ้ายังไม่มี เคสที่มีอยู่แล้วไม่แก้ข้อมูล
async function jobId(p) {
  const created = check(await supabase.from('jobs').upsert({
    message_id: p.messageId, channel_id: p.channelId, channel_name: p.channelName ?? null,
    user_id: p.userId, username: p.username, caption: p.caption ?? '', workers: p.workers ?? [],
    message_url: p.messageUrl ?? null, taken_at: p.takenAt, month: p.month, day: p.day,
  }, { onConflict: 'message_id', ignoreDuplicates: true }).select('id'));
  if (created.length) return created[0].id;
  return check(await supabase.from('jobs').select('id').eq('message_id', p.messageId).single()).id;
}

// คืน { changes: 1 } เมื่อเพิ่มรูปใหม่ หรือ { changes: 0 } เมื่อรูปนี้มีอยู่แล้ว
export async function insertPhoto(p) {
  const data = check(await supabase.from('photos').upsert({
    job_id: await jobId(p), attachment_id: p.attachmentId, file_path: p.filePath,
  }, { onConflict: 'attachment_id', ignoreDuplicates: true }).select('id'));
  return { changes: data.length };
}

// ลิงก์โพสต์ใน Discord ของงาน /sendreport (รู้หลังบันทึกรูปแล้วโพสต์ลงห้อง)
export async function setJobUrl(messageId, url) {
  check(await supabase.from('jobs').update({ message_url: url }).eq('message_id', messageId));
}

// 1 งาน = รูปทั้งหมดที่ส่งมาพร้อมกันในครั้งเดียว (message_id เดียวกัน)
export async function listMonths() {
  return check(await supabase.from('month_summary').select('month, jobs, photos').order('month', { ascending: false }));
}

// เคสของเดือน พร้อมรูปของแต่ละเคส (ข้ามเคสที่ไม่มีรูป เช่น อัปโหลดไม่สำเร็จ)
async function monthJobs(month) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const data = check(await supabase.from('jobs').select('*, photos(id, attachment_id, file_path)').eq('month', month)
      .order('taken_at', { ascending: false }).order('id', { ascending: true })
      .order('id', { referencedTable: 'photos', ascending: true })
      .range(from, from + PAGE - 1));
    rows.push(...data);
    if (data.length < PAGE) return rows.filter((j) => j.photos.length);
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
  const rows = await monthJobs(month);

  const jobMap = new Map();
  const dayJobs = new Map(); // day -> จำนวนเคส
  const userStats = new Map(); // user_id -> { username, jobs, photos }
  const workerStats = new Map(); // worker id -> { name, jobs }
  for (const j of rows) {
    const workers = j.workers ?? [];
    jobMap.set(j.id, {
      id: j.id, caption: j.caption, username: j.username, workers, taken_at: j.taken_at,
      channel_name: j.channel_name, message_url: j.message_url,
      photos: j.photos.map((p) => ({ id: p.id, file_path: p.file_path, link: photoLink(p.attachment_id) })),
    });
    for (const w of workers) {
      let s = workerStats.get(w.id);
      if (!s) workerStats.set(w.id, (s = { name: w.name, jobs: 0 }));
      s.jobs++;
    }
    dayJobs.set(j.day, (dayJobs.get(j.day) ?? 0) + 1);

    let u = userStats.get(j.user_id);
    if (!u) userStats.set(j.user_id, (u = { username: j.username, jobs: 0, photos: 0 }));
    u.jobs++;
    u.photos += j.photos.length;
  }

  const allPhotos = [...jobMap.values()].flatMap((j) => j.photos);
  if (sign) {
    const urls = await signUrls(allPhotos.map((p) => p.file_path));
    for (const ph of allPhotos) ph.url = urls.get(ph.file_path) ?? '';
  }

  return {
    month,
    totalJobs: jobMap.size,
    totalPhotos: allPhotos.length,
    byDay: [...dayJobs].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
    byUser: [...userStats.values()].sort((a, b) => b.jobs - a.jobs),
    byWorker: [...workerStats.values()].sort((a, b) => b.jobs - a.jobs),
    jobs: [...jobMap.values()],
  };
}
