import {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, ContextMenuCommandBuilder,
  ApplicationCommandType, MessageFlags, Partials,
  ModalBuilder, LabelBuilder, FileUploadBuilder,
} from 'discord.js';
import path from 'node:path';
import { insertPhoto, uploadFile, photoLink, setJobUrl } from './db.js';

const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';
const ALLOWED = (process.env.CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
// เปิดเพื่อให้บอทเก็บรูปจากทุกข้อความในช่อง (ต้องเปิด Message Content Intent)
const AUTO_CAPTURE = process.env.AUTO_CAPTURE === 'true';
const MAX_PHOTOS = 10; // Discord จำกัดไฟล์ในช่องเลือกรูปไม่เกิน 10 ต่อครั้ง
const REPORT_EMOJI = '📸'; // รีแอคอีโมจินี้ที่ข้อความรูป = ส่งเข้ารายงาน
const MODAL_PREFIX = 'sendreport-modal:'; // ตามด้วย session id
const SESSION_TTL_MS = 60 * 60 * 1000; // แคปชั่นที่รอให้เลือกรูปหมดอายุใน 1 ชม.
const sessions = new Map(); // session id -> { caption, workers, expires }
const WORKER_OPTIONS = ['คนทำ', 'คนทำ2', 'คนทำ3'];

function newSession(id, caption, workers) {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  sessions.set(id, { caption, workers, expires: now + SESSION_TTL_MS });
}

const displayName = (user, member) => member?.displayName ?? user.globalName ?? user.username;

// คนทำจากช่อง คนทำ/คนทำ2/คนทำ3 ตัดคนซ้ำออก คืน [{ id, name }]
function workersFrom(it) {
  const workers = new Map();
  for (const name of WORKER_OPTIONS) {
    const user = it.options.getUser(name);
    if (user && !workers.has(user.id)) {
      workers.set(user.id, { id: user.id, name: displayName(user, it.options.getMember(name)) });
    }
  }
  return [...workers.values()];
}

// en-CA ให้รูปแบบ YYYY-MM-DD
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

const command = new SlashCommandBuilder()
  .setName('sendreport')
  .setDescription('ส่งรูปเข้ารายงานประจำเดือน (ใส่แคปชั่น แล้วเลือกรูป)')
  .addStringOption((o) => o.setName('caption').setDescription('แคปชั่นของรูป').setRequired(true).setMaxLength(200))
  .addUserOption((o) => o.setName('คนทำ').setDescription('คนที่ทำงานนี้').setRequired(true))
  .addUserOption((o) => o.setName('คนทำ2').setDescription('คนทำคนที่ 2 (ถ้ามี)'))
  .addUserOption((o) => o.setName('คนทำ3').setDescription('คนทำคนที่ 3 (ถ้ามี)'));

const menuCommand = new ContextMenuCommandBuilder()
  .setName('ส่งเข้ารายงาน')
  .setType(ApplicationCommandType.Message);

function isImage(att) {
  return att.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(att.name ?? '');
}

function channelAllowed(channelId) {
  return !ALLOWED.length || ALLOWED.includes(channelId);
}

// ดาวน์โหลดรูปจาก Discord อัปโหลดขึ้น Supabase Storage แล้วบันทึกลงฐานข้อมูล (ไม่เก็บอะไรในเครื่อง)
// คืน true เมื่อบันทึกใหม่สำเร็จ
async function savePhoto({ att, messageId, channelId, channelName, messageUrl, user, caption, workers = [], takenAt }) {
  const day = dayFmt.format(takenAt);
  const month = day.slice(0, 7);

  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ext = path.extname(att.name ?? '') || '.jpg';
  const filePath = `${month}/${takenAt}-${att.id}${ext}`;
  await uploadFile(filePath, Buffer.from(await res.arrayBuffer()), att.contentType ?? 'application/octet-stream');

  const r = await insertPhoto({
    messageId, attachmentId: att.id, channelId, channelName, messageUrl,
    userId: user.id, username: user.displayName,
    caption, workers, filePath, takenAt, month, day,
  });
  return r.changes > 0;
}

// บันทึกรูปทั้งชุด คืนสรุปจำนวน
async function saveAll(atts, base) {
  const images = [...atts].filter(isImage);
  const result = { total: images.length, saved: 0, duplicate: 0, failed: [], ok: [] };
  for (const att of images) {
    try {
      if (await savePhoto({ ...base, att })) result.saved++; else result.duplicate++;
      result.ok.push(att);
    } catch (err) {
      console.error(`บันทึกรูปไม่สำเร็จ (${att.name}):`, err.message);
      result.failed.push(att.name);
    }
  }
  return result;
}

function summary(r) {
  if (!r.total) return 'ไม่พบไฟล์รูปภาพ';
  if (!r.saved && r.duplicate && !r.failed.length) return 'รูปนี้อยู่ในรายงานแล้ว';
  return `✅ บันทึก ${r.saved} รูปเข้ารายงานแล้ว` + (r.duplicate ? ` (ซ้ำ ${r.duplicate})` : '')
    + (r.failed.length ? `\n⚠️ ไม่สำเร็จ: ${r.failed.join(', ')}` : '');
}

// โพสต์รูปที่บันทึกแล้วลงช่อง ให้ทุกคนเห็นงาน (รูปจากหน้าต่างเลือกรูปคนอื่นมองไม่เห็น)
// แท็กชื่อแต่ไม่ส่งแจ้งเตือน
function postToChannel(it, atts, caption, workers) {
  const lines = [`📸 **${caption}**`];
  if (workers.length) lines.push(`👷 คนทำ: ${workers.map((w) => `<@${w.id}>`).join(' ')}`);
  lines.push(`ส่งโดย <@${it.user.id}>`);
  // <...> กันไม่ให้ Discord สร้างพรีวิวลิงก์ซ้ำกับรูปที่แนบ
  lines.push(`🔗 ลิงก์รูป: ${atts.map((a, i) => `[${i + 1}](<${photoLink(a.id)}>)`).join(' ')}`);
  return it.followUp({
    content: lines.join('\n'),
    files: atts.map((a) => ({ attachment: a.url, name: a.name })),
    allowedMentions: { parse: [] },
  });
}

// เก็บรูปทั้งหมดในข้อความหนึ่งๆ (ใช้กับเมนูคลิกขวาและรีแอค 📸)
function saveMessageImages(m) {
  return saveAll(m.attachments.values(), {
    messageId: m.id, channelId: m.channelId, channelName: m.channel?.name, messageUrl: m.url,
    user: { id: m.author.id, displayName: m.member?.displayName ?? m.author.globalName ?? m.author.username },
    caption: m.content ?? '', takenAt: m.createdTimestamp,
  });
}

function buildModal(sessionId) {
  return new ModalBuilder()
    .setCustomId(MODAL_PREFIX + sessionId)
    .setTitle('เพิ่มรูปเข้ารายงาน')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(`เลือกรูป (ได้สูงสุด ${MAX_PHOTOS} รูป)`)
        .setFileUploadComponent(
          new FileUploadBuilder().setCustomId('photos').setMinValues(1).setMaxValues(MAX_PHOTOS).setRequired(true),
        ),
    );
}

async function registerCommand(client) {
  // ลงทะเบียนแบบรายเซิร์ฟเวอร์ ใช้ได้ทันที (แบบ global ใช้เวลาหลายนาที)
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set([command.toJSON(), menuCommand.toJSON()]);
      console.log(`ลงทะเบียนคำสั่ง (/sendreport + เมนู ส่งเข้ารายงาน) ในเซิร์ฟเวอร์: ${guild.name}`);
    } catch (err) {
      console.error(
        `ลงทะเบียนคำสั่งใน "${guild.name}" ไม่สำเร็จ: ${err.message}\n` +
        '→ เชิญบอทใหม่ด้วย scope "applications.commands" (OAuth2 > URL Generator ติ๊ก bot + applications.commands)',
      );
    }
  }
}

export function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`บอทออนไลน์: ${c.user.tag}`);
    await registerCommand(c);
  });
  client.on(Events.GuildCreate, () => registerCommand(client));

  client.on(Events.InteractionCreate, async (it) => {
    // /sendreport (ใส่แคปชั่นแล้ว Enter) -> เปิดหน้าต่างเลือกรูป
    if (it.isChatInputCommand() && it.commandName === command.name) {
      if (!channelAllowed(it.channelId)) {
        return it.reply({
          content: `ใช้คำสั่งนี้ได้เฉพาะในช่อง ${ALLOWED.map((id) => `<#${id}>`).join(', ')}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      newSession(it.id, it.options.getString('caption', true), workersFrom(it));
      return it.showModal(buildModal(it.id));
    }

    // ส่งหน้าต่างเลือกรูป -> บันทึก
    if (it.isModalSubmit() && it.customId.startsWith(MODAL_PREFIX)) {
      const id = it.customId.slice(MODAL_PREFIX.length);
      const session = sessions.get(id);
      if (!session) {
        return it.reply({ content: 'หมดเวลาแล้ว พิมพ์ /sendreport ใหม่อีกครั้ง', flags: MessageFlags.Ephemeral });
      }
      sessions.delete(id); // ใช้ครั้งเดียว กันกดส่งซ้ำ
      await it.deferReply({ flags: MessageFlags.Ephemeral });
      const files = it.fields.getUploadedFiles('photos', true);
      const r = await saveAll(files.values(), {
        messageId: it.id, channelId: it.channelId, channelName: it.channel?.name,
        user: { id: it.user.id, displayName: displayName(it.user, it.member) },
        caption: session.caption, workers: session.workers, takenAt: it.createdTimestamp,
      });
      await it.editReply(`${summary(r)}\n📝 ${session.caption}\n👷 ${session.workers.map((w) => w.name).join(', ')}`);
      if (r.ok.length) {
        try {
          const post = await postToChannel(it, r.ok, session.caption, session.workers);
          await setJobUrl(it.id, post.url).catch((err) => console.error('บันทึกลิงก์โพสต์ไม่สำเร็จ:', err.message));
        } catch (err) {
          console.error('โพสต์รูปลงช่องไม่สำเร็จ:', err.message);
          await it.followUp({ content: '⚠️ บันทึกแล้ว แต่โพสต์รูปลงช่องไม่สำเร็จ (ไฟล์อาจใหญ่เกินไป)', flags: MessageFlags.Ephemeral });
        }
      }
      return;
    }

    // คลิกขวาที่ข้อความ -> ส่งเข้ารายงาน
    if (it.isMessageContextMenuCommand() && it.commandName === menuCommand.name) {
      if (!channelAllowed(it.channelId)) {
        return it.reply({ content: 'ใช้ในช่องนี้ไม่ได้', flags: MessageFlags.Ephemeral });
      }
      // ข้อความของบอทคือรูปที่โพสต์จาก /sendreport ซึ่งอยู่ในรายงานแล้ว
      if (it.targetMessage.author.bot) {
        return it.reply({ content: 'รูปนี้อยู่ในรายงานแล้ว', flags: MessageFlags.Ephemeral });
      }
      await it.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await saveMessageImages(it.targetMessage);
      return it.editReply(r.total ? summary(r) : 'ข้อความนี้ไม่มีรูปภาพ');
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== REPORT_EMOJI) return;
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch { return; }
    const m = reaction.message;
    if (m.author?.bot || !channelAllowed(m.channelId)) return;
    const r = await saveMessageImages(m);
    if (r.saved) await m.react('✅').catch(() => {});
  });

  if (AUTO_CAPTURE) {
    client.on(Events.MessageCreate, async (msg) => {
      if (msg.author.bot || !channelAllowed(msg.channelId)) return;
      const r = await saveMessageImages(msg);
      if (r.saved) await msg.react('✅').catch(() => {});
    });
  }

  return client.login(process.env.DISCORD_TOKEN);
}
