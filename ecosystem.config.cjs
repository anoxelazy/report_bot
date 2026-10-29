// pm2: รันบอทตลอดเวลาและเปิดใหม่อัตโนมัติเมื่อหยุด
// เริ่ม: pm2 start ecosystem.config.cjs   ดู log: pm2 logs report-bot   รีสตาร์ท: pm2 restart report-bot
module.exports = {
  apps: [{
    name: 'report-bot',
    script: 'src/index.js',
    cwd: __dirname,
    node_args: '--env-file=.env',
    autorestart: true,
    restart_delay: 5000, // รอ 5 วินาทีก่อนเปิดใหม่ กันวนเปิดถี่ตอนเน็ตหลุด
    max_memory_restart: '500M',
    time: true, // ใส่เวลาใน log
  }],
};
