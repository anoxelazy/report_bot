import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMonths, monthReport, signedPhotoUrl } from './db.js';
import { exportCsv, exportXlsx, exportZip } from './export.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// สร้างแอปเว็บ (ใช้ทั้งรันในเครื่องและบน Vercel ผ่าน api/index.js)
export function createApp() {
  const app = express();
  const password = process.env.DASHBOARD_PASSWORD;
  app.disable('x-powered-by');

  // security headers ใส่ที่ Express เพราะบน Vercel ทุกเส้นทางถูก rewrite มาที่ฟังก์ชันนี้ (ใช้ได้ทั้งในเครื่องและบน Vercel)
  // รูปมาจาก signed URL ของ Supabase และ realtime ใช้ wss ไปที่ Supabase
  const supabase = process.env.SUPABASE_URL ?? '';
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' ${supabase}`,
    `connect-src 'self' ${supabase} ${supabase.replace(/^http/, 'ws')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });

  if (password) {
    app.use((req, res, next) => {
      const [, b64] = (req.headers.authorization ?? '').split(' ');
      const pass = Buffer.from(b64 ?? '', 'base64').toString().split(':').slice(1).join(':');
      if (pass === password) return next();
      res.set('WWW-Authenticate', 'Basic realm="Dashboard"').status(401).send('ต้องใส่รหัสผ่าน');
    });
  }

  const fail = (res, err) => {
    console.error('api error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  };

  // ค่าที่หน้าเว็บใช้ต่อ Supabase Realtime (publishable key เปิดเผยได้ ห้ามส่ง service key)
  app.get('/api/config', (_req, res) => {
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    res.json(key ? { supabaseUrl: process.env.SUPABASE_URL, supabaseKey: key } : {});
  });

  app.get('/api/months', async (_req, res) => {
    try { res.json(await listMonths()); } catch (err) { fail(res, err); }
  });
  app.get('/api/report/:month', async (req, res) => {
    if (!/^\d{4}-\d{2}$/.test(req.params.month)) return res.status(400).json({ error: 'month ต้องเป็น YYYY-MM' });
    try { res.json(await monthReport(req.params.month)); } catch (err) { fail(res, err); }
  });

  // ลิงก์ถาวรของรูป: ออกลิงก์ชั่วคราวใหม่แล้วพาไปที่รูป
  app.get('/p/:attachmentId', async (req, res) => {
    if (!/^\d+$/.test(req.params.attachmentId)) return res.status(404).send('ไม่พบรูป');
    try {
      const url = await signedPhotoUrl(req.params.attachmentId);
      if (!url) return res.status(404).send('ไม่พบรูป');
      res.set('Cache-Control', 'no-store').redirect(302, url);
    } catch (err) { fail(res, err); }
  });

  app.get('/api/export/:month/:format', async (req, res) => {
    const { month, format } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month ต้องเป็น YYYY-MM' });
    const name = `report-${month}`;
    try {
      if (format === 'csv') {
        res.type('text/csv; charset=utf-8').attachment(`${name}.csv`).send(await exportCsv(month));
      } else if (format === 'xlsx') {
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .attachment(`${name}.xlsx`).send(Buffer.from(await exportXlsx(month)));
      } else if (format === 'zip') {
        res.type('application/zip').attachment(`${name}-photos.zip`);
        await exportZip(month, res);
      } else {
        res.status(404).json({ error: 'format ต้องเป็น csv, xlsx หรือ zip' });
      }
    } catch (err) {
      console.error('export error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'ส่งออกไม่สำเร็จ' });
    }
  });

  app.use(express.static(WEB_DIR));
  return app;
}

export function startServer() {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Dashboard: http://localhost:${port}`));
}
