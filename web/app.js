const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ลิงก์จากข้อมูลต้องเป็น http(s) เท่านั้น กัน javascript: URL
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '');
const fmtTime = (ms) => new Date(ms).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

// สีประจำตัวแต่ละคน คิดจากชื่อ คนเดิมได้สีเดิมทุกที่ (ตัวอักษรขาวอ่านได้ทุกสี)
const PERSON_COLORS = ['#5865f2', '#2f9e44', '#e8590c', '#c2255c', '#1971c2', '#9c36b5', '#0c8599', '#e03131', '#5c940d', '#8d5524'];
function personColor(name) {
  let h = 0;
  for (const ch of name ?? '') h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length];
}
const chip = (name) => `<span class="chip" style="background:${personColor(name)}">${esc(name)}</span>`;

let viewing = { srcs: [], i: 0 };

// keep = คงเดือนที่เลือกไว้ (ใช้ตอนรีเฟรชอัตโนมัติ)
async function loadMonths(keep) {
  const months = await (await fetch('/api/months')).json();
  monthsSig = JSON.stringify(months);
  const sel = $('month');
  if (!months.length) {
    const now = new Date().toISOString().slice(0, 7);
    sel.innerHTML = `<option value="${esc(now)}">${esc(now)}</option>`;
  } else {
    sel.innerHTML = months.map((m) => `<option value="${esc(m.month)}">${esc(m.month)} (${Number(m.jobs)} งาน / ${Number(m.photos)} รูป)</option>`).join('');
  }
  if (keep && months.some((m) => m.month === keep)) sel.value = keep;
  await loadReport(sel.value);
}

// Realtime: ฐานข้อมูลส่งสัญญาณเมื่อมีรูปใหม่ แล้วหน้าเว็บโหลดข้อมูลใหม่ผ่าน API
// รอสักครู่ก่อนโหลด เพราะงานหนึ่งส่งรูปมาหลายรูปติดกัน
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadMonths($('month').value).catch((err) => console.error(err)), 1500);
}

// สำรอง: เช็คยอดรวมทุก 15 วินาที และตอนกลับมาที่แท็บ เผื่อ realtime ต่อไม่ติด (เช่น เน็ตบริษัทบล็อก WebSocket)
// โหลดรายงานใหม่เฉพาะเมื่อยอดเปลี่ยน รูปจะได้ไม่กระพริบ
let monthsSig = '';
async function checkForUpdates() {
  if (document.hidden) return;
  try {
    const sig = JSON.stringify(await (await fetch('/api/months')).json());
    if (sig !== monthsSig) scheduleRefresh();
  } catch (err) { console.error('check updates:', err); }
}
setInterval(checkForUpdates, 15000);
document.addEventListener('visibilitychange', checkForUpdates);

async function startRealtime() {
  const cfg = await (await fetch('/api/config')).json();
  if (!cfg.supabaseKey || !window.supabase) return;
  let connectedBefore = false;
  window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey)
    .channel('photos')
    .on('broadcast', { event: 'new_photo' }, scheduleRefresh)
    .subscribe((status, err) => {
      const live = status === 'SUBSCRIBED';
      $('live').classList.toggle('on', live);
      $('live').title = live ? 'อัปเดตทันที' : 'อัปเดตทุก 15 วินาที';
      if (!live) console.warn('realtime:', status, err?.message ?? '');
      // ต่อใหม่หลังหลุด (เช่น คอมพ์หลับ) อาจพลาดสัญญาณไป จึงโหลดใหม่หนึ่งครั้ง
      if (live && connectedBefore) scheduleRefresh();
      if (live) connectedBefore = true;
    });
}

function setExportLinks(month) {
  for (const f of ['xlsx', 'csv', 'zip']) $(f).href = `/api/export/${month}/${f}`;
}

async function loadReport(month) {
  setExportLinks(month);
  const r = await (await fetch(`/api/report/${month}`)).json();
  $('jobs').textContent = r.totalJobs;
  $('total').textContent = r.totalPhotos;
  $('people').textContent = r.byUser.length;
  $('avg').textContent = r.byDay.length ? (r.totalJobs / r.byDay.length).toFixed(1) : 0;

  const [y, m] = month.split('-').map(Number);
  $('subtitle').textContent = new Date(y, m - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  // กราฟแสดงครบทุกวันของเดือน (วันที่ไม่มีงานเป็นแท่งว่าง)
  const perDay = new Map(r.byDay.map((d) => [Number(d.day.slice(8)), d.count]));
  const daysInMonth = new Date(y, m, 0).getDate();
  const max = Math.max(1, ...perDay.values());
  const peakDay = [...perDay].reduce((best, cur) => (cur[1] > (best?.[1] ?? 0) ? cur : best), null);
  $('peak').textContent = peakDay ? `สูงสุด วันที่ ${peakDay[0]} (${peakDay[1]} งาน)` : '';
  $('bars').innerHTML = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const n = perDay.get(day) ?? 0;
    const label = day === 1 || day % 5 === 0 ? day : '';
    return `<div class="col${n ? '' : ' zero'}" data-tip="วันที่ ${day}: ${n} งาน">
      <div class="bar${peakDay && peakDay[0] === day ? ' peak' : ''}" style="height:${n ? Math.max(4, (n / max) * 100) + '%' : ''}"></div><span>${label}</span></div>`;
  }).join('');

  const topJobs = Math.max(1, ...r.byUser.map((u) => u.jobs));
  $('users').innerHTML = r.byUser.length
    ? r.byUser.map((u) => `
        <li>
          <span class="av" style="background:${personColor(u.username)}">${esc(Array.from(u.username)[0] ?? '?')}</span>
          <div class="who"><div class="nm">${esc(u.username)}</div><div class="meter"><i style="width:${(u.jobs / topJobs) * 100}%;background:${personColor(u.username)}"></i></div></div>
          <div class="cnt"><b>${u.jobs} งาน</b><small>${u.photos} รูป</small></div>
        </li>`).join('')
    : '<li style="color:var(--muted)">ยังไม่มีผู้ส่งงานในเดือนนี้</li>';

  const topWorker = Math.max(1, ...r.byWorker.map((w) => w.jobs));
  $('workers').innerHTML = r.byWorker.length
    ? r.byWorker.map((w) => `
        <li>
          <span class="av" style="background:${personColor(w.name)}">${esc(Array.from(w.name)[0] ?? '?')}</span>
          <div class="who"><div class="nm">${esc(w.name)}</div><div class="meter"><i style="width:${(w.jobs / topWorker) * 100}%;background:${personColor(w.name)}"></i></div></div>
          <div class="cnt"><b>${w.jobs} งาน</b></div>
        </li>`).join('')
    : '<li style="color:var(--muted)">ยังไม่มีข้อมูลคนทำในเดือนนี้</li>';

  report = r;
  fillPeople(r.jobs);
  renderJobs();
}

// กรองงานตามคน: งานที่คนนั้นเป็นคนทำหรือเป็นคนส่ง (ค่าว่าง = ทุกคน)
let report = { jobs: [] };
const hasPerson = (j, name) => j.username === name || j.workers.some((w) => w.name === name);

// คงคนที่เลือกไว้ตอนรีเฟรช ถ้าเดือนนี้ยังมีคนนั้นอยู่
function fillPeople(jobs) {
  const sel = $('person');
  const keep = sel.value;
  const names = [...new Set(jobs.flatMap((j) => [...j.workers.map((w) => w.name), j.username]))]
    .sort((a, b) => a.localeCompare(b, 'th'));
  sel.innerHTML = '<option value="">👥 ทุกคน</option>'
    + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = names.includes(keep) ? keep : '';
}

function renderJobs() {
  const person = $('person').value;
  const jobs = person ? report.jobs.filter((j) => hasPerson(j, person)) : report.jobs;
  $('jobsList').innerHTML = jobs.length
    ? jobs.map((j, n) => `
        <article class="job" style="border-left-color:${personColor(j.username)}">
          <div class="detail">
          <h3>${esc(j.caption) || '<i>ไม่มีแคปชั่น</i>'}<span class="badge">${j.photos.length} รูป</span></h3>
          <dl class="info">
            <dt>👷 คนทำ</dt><dd>${j.workers.length ? j.workers.map((w) => chip(w.name)).join(' ') : '<span class="none">ไม่ระบุ</span>'}</dd>
            <dt>📤 ส่งโดย</dt><dd>${chip(j.username)}</dd>
            <dt>🕒 เวลา</dt><dd>${fmtTime(j.taken_at)}</dd>
            ${j.channel_name ? `<dt>💬 ห้อง</dt><dd>#${esc(j.channel_name)}</dd>` : ''}
            <dt>🔗 ลิงก์รูป</dt><dd>${j.photos.map((p, k) => `<a href="${esc(p.link)}" target="_blank" rel="noopener">${k + 1}</a>`).join(' ')}</dd>
          </dl>
          ${safeUrl(j.message_url) ? `<a class="discord" href="${esc(safeUrl(j.message_url))}" target="_blank" rel="noopener">เปิดโพสต์ใน Discord ↗</a>` : ''}
          </div>
          <div class="thumbs" data-job="${n}">
            ${j.photos.map((p, k) => `<img loading="lazy" data-k="${k}" src="${esc(p.url)}" alt="${esc(j.caption || 'รูปงาน')} ${k + 1}">`).join('')}
          </div>
        </article>`).join('')
    : `<div class="empty">${person ? `ไม่มีงานของ ${esc(person)} ในเดือนนี้` : 'ยังไม่มีงานในเดือนนี้'}</div>`;
  window.__jobs = jobs;
}

function show(i) {
  const n = viewing.srcs.length;
  viewing.i = (i + n) % n;
  $('viewer').querySelector('img').src = viewing.srcs[viewing.i];
  $('open').href = viewing.links[viewing.i];
}

$('month').addEventListener('change', (e) => loadReport(e.target.value));
$('person').addEventListener('change', renderJobs);
$('print').addEventListener('click', () => window.print());
$('jobsList').addEventListener('click', (e) => {
  if (e.target.tagName !== 'IMG') return;
  const job = window.__jobs[Number(e.target.parentElement.dataset.job)];
  viewing.srcs = job.photos.map((p) => p.url);
  viewing.links = job.photos.map((p) => p.link);
  show(Number(e.target.dataset.k));
  $('viewer').showModal();
});
$('prev').addEventListener('click', (e) => { e.stopPropagation(); show(viewing.i - 1); });
$('next').addEventListener('click', (e) => { e.stopPropagation(); show(viewing.i + 1); });
$('open').addEventListener('click', (e) => e.stopPropagation());
$('viewer').addEventListener('click', () => $('viewer').close());
document.addEventListener('keydown', (e) => {
  if (!$('viewer').open) return;
  if (e.key === 'ArrowLeft') show(viewing.i - 1);
  if (e.key === 'ArrowRight') show(viewing.i + 1);
});

loadMonths();
startRealtime().catch((err) => console.error('realtime:', err));
