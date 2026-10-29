import ExcelJS from 'exceljs';
import { ZipArchive } from 'archiver';
import path from 'node:path';
import { monthReport, downloadFile } from './db.js';

const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';
const dateFmt = new Intl.DateTimeFormat('th-TH', { timeZone: TIMEZONE, dateStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat('th-TH', { timeZone: TIMEZONE, timeStyle: 'short' });

// แปลงรายงานเดือนเป็นแถวของแต่ละงาน
async function jobRows(month) {
  const report = await monthReport(month, { sign: false });
  return {
    report,
    rows: report.jobs.map((j, i) => ({
      no: i + 1,
      date: dateFmt.format(j.taken_at),
      time: timeFmt.format(j.taken_at),
      username: j.username,
      caption: j.caption,
      count: j.photos.length,
      files: j.photos.map((p) => path.basename(p.file_path)).join(', '),
      job: j,
    })),
  };
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export async function exportCsv(month) {
  const { rows } = await jobRows(month);
  const head = ['ลำดับ', 'วันที่', 'เวลา', 'ผู้ส่ง', 'แคปชั่น', 'จำนวนรูป', 'ไฟล์รูป'];
  const lines = [head, ...rows.map((r) => [r.no, r.date, r.time, r.username, r.caption, r.count, r.files])];
  // BOM ให้ Excel เปิดภาษาไทยไม่เพี้ยน
  return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

export async function exportXlsx(month) {
  const { report, rows } = await jobRows(month);
  const wb = new ExcelJS.Workbook();

  const jobs = wb.addWorksheet('งาน');
  jobs.columns = [
    { header: 'ลำดับ', key: 'no', width: 8 },
    { header: 'วันที่', key: 'date', width: 16 },
    { header: 'เวลา', key: 'time', width: 10 },
    { header: 'ผู้ส่ง', key: 'username', width: 22 },
    { header: 'แคปชั่น', key: 'caption', width: 40 },
    { header: 'จำนวนรูป', key: 'count', width: 12 },
    { header: 'ไฟล์รูป', key: 'files', width: 60 },
  ];
  rows.forEach((r) => jobs.addRow(r));
  jobs.addRow({});
  jobs.addRow({ caption: `รวม ${report.totalJobs} งาน`, count: report.totalPhotos }).font = { bold: true };

  const photos = wb.addWorksheet('รูป');
  photos.columns = [
    { header: 'งานที่', key: 'job', width: 8 },
    { header: 'แคปชั่น', key: 'caption', width: 40 },
    { header: 'ผู้ส่ง', key: 'username', width: 22 },
    { header: 'ไฟล์', key: 'file', width: 50 },
  ];
  rows.forEach((r) => r.job.photos.forEach((p) => photos.addRow({
    job: r.no, caption: r.caption, username: r.username, file: path.basename(p.file_path),
  })));

  for (const ws of [jobs, photos]) {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E6EC' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
  }
  return wb.xlsx.writeBuffer();
}

// ชื่อโฟลเดอร์ที่ปลอดภัยบน Windows
const safe = (s) => (s || 'ไม่มีแคปชั่น').replace(/[\\/:*?"<>|\r\n]/g, ' ').trim().slice(0, 40) || 'งาน';

export async function exportZip(month, res) {
  const { rows } = await jobRows(month);
  const zip = new ZipArchive({ zlib: { level: 1 } }); // รูปบีบอัดอยู่แล้ว ใช้ระดับต่ำให้เร็ว
  zip.on('error', (err) => { console.error('zip error:', err.message); res.destroy(err); });
  zip.pipe(res);
  for (const r of rows) {
    const dir = `${month}/งาน ${String(r.no).padStart(2, '0')} - ${safe(r.caption)}`;
    for (const [i, p] of r.job.photos.entries()) {
      try {
        // ดึงทีละรูปจาก Supabase เพื่อไม่ให้กินหน่วยความจำ
        zip.append(await downloadFile(p.file_path), { name: `${dir}/${i + 1}${path.extname(p.file_path)}` });
      } catch (err) {
        console.error(`ข้ามรูป ${p.file_path}:`, err.message);
      }
    }
  }
  await zip.finalize();
}
