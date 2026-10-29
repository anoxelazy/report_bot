import { startServer } from './server.js';
import { startBot } from './bot.js';

startServer();

if (process.env.DISCORD_TOKEN) {
  startBot().catch((err) => console.error('บอทเริ่มไม่ได้:', err.message));
} else {
  console.warn('ไม่พบ DISCORD_TOKEN ใน .env — เปิดเฉพาะ dashboard');
}
