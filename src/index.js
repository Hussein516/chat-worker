import { DurableObject } from "cloudflare:workers";

const KICK_MESSAGE = "تم طردك بسبب مخالفة قوانين الشات";
const HISTORY_LIMIT = 30;
const RATE_LIMIT_PER_USER = 15;
const RATE_LIMIT_WINDOW_MS = 10000;
const PING_INTERVAL_MS = 25000;
const STALE_MS = 70000;
const MAX_USERNAME_LEN = 32;
const MAX_MESSAGE_LEN = 300;
const AUTH_TIMEOUT_MS = 3000;

const SCRIPT_SOURCES = [
  "https://gist.githubusercontent.com/Hussein516/639729fccb66180848cf5364ce71870f/raw/626e5f6c464b0ea79530d983cb5fd70ab8c056b1/chat.lua",
  "https://cdn.jsdelivr.net/gh/Hussein516/Script@main/Idk",
  "https://raw.githubusercontent.com/Hussein516/Script/main/Idk",
];
const EMBEDDED_SCRIPT_FALLBACK = "warn('[Chat] فشل تحميل السكربت من Worker')\n";

async function serveScript() {
  for (const url of SCRIPT_SOURCES) {
    try {
      const res = await fetch(url, {
        cf: { cacheTtl: 60, cacheEverything: true },
        headers: { "User-Agent": "Cloudflare-Worker-Proxy/1.0" },
      });
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 100) {
          return new Response(text, {
            status: 200,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "public, max-age=60",
              "access-control-allow-origin": "*",
            },
          });
        }
      }
    } catch (e) {}
  }
  return new Response(EMBEDDED_SCRIPT_FALLBACK, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

export class ChatRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.env = env;
    this.sessions = new Map();
    this.messages = [];
    this.bannedUsers = new Set();
    this.moderators = new Set();
    this.reports = [];
    this.pingTimer = null;
    this.ready = this.loadState();
  }

  async loadState() {
    try {
      const stored = await this.ctx.storage.get("banned");
      if (Array.isArray(stored)) this.bannedUsers = new Set(stored.map(u => String(u).toLowerCase()));
      const mods = await this.ctx.storage.get("mods");
      if (Array.isArray(mods)) this.moderators = new Set(mods.map(u => String(u).toLowerCase()));
      const reports = await this.ctx.storage.get("reports");
      if (Array.isArray(reports)) this.reports = reports;
    } catch (e) {}
  }

  async saveBanned() { try { await this.ctx.storage.put("banned", Array.from(this.bannedUsers)); } catch (e) {} }
  async saveMods() { try { await this.ctx.storage.put("mods", Array.from(this.moderators)); } catch (e) {} }
  async saveReports() {
    try { this.reports = this.reports.slice(-200); await this.ctx.storage.put("reports", this.reports); } catch (e) {}
  }

  containsLink(text) {
    if (!text) return false;
    return /(?:https?:\/\/|www\.)\S+|\bdiscord\.gg\/\S+|\b(?:t\.me|telegram\.me)\/\S+/i.test(text);
  }

  getOwnerUsername() { return (this.env && this.env.OWNER_USERNAME) || "maalek_1234"; }
  getOwnerToken() { return (this.env && this.env.OWNER_TOKEN) || ""; }

  removeSession(ws) {
    const s = this.sessions.get(ws);
    if (!s) return;
    this.sessions.delete(ws);
    if (s.announced && s.username) {
      this.broadcast(JSON.stringify({ type: "leave", username: s.username }), null);
    }
  }

  broadcast(payload, excludeWs) {
    const dead = [];
    for (const [ws] of this.sessions) {
      if (ws === excludeWs) continue;
      try { ws.send(payload); } catch (e) { dead.push(ws); }
    }
    for (const ws of dead) { try { ws.close(); } catch (e) {} this.removeSession(ws); }
  }

  startPing() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (this.sessions.size === 0) { clearInterval(this.pingTimer); this.pingTimer = null; return; }
      const now = Date.now();
      const stale = [];
      for (const [ws, s] of this.sessions) if (now - s.lastSeen > STALE_MS) stale.push(ws);
      for (const ws of stale) { try { ws.close(); } catch (e) {} this.removeSession(ws); }
      this.broadcast(JSON.stringify({ type: "ping", t: now }), null);
    }, PING_INTERVAL_MS);
  }

  checkRateLimit(session) {
    const now = Date.now();
    if (now - session.rateReset > RATE_LIMIT_WINDOW_MS) { session.rateCount = 0; session.rateReset = now; }
    session.rateCount++;
    return session.rateCount <= RATE_LIMIT_PER_USER;
  }

  findSessionsByTarget(targetName) {
    const target = String(targetName || "").toLowerCase().trim();
    if (!target) return [];
    const matches = [];
    for (const [ws, s] of this.sessions.entries()) {
      if (!s.username) continue;
      const uname = s.username.toLowerCase();
      const dname = (s.displayName || "").toLowerCase();
      const uid = s.userId ? String(s.userId) : "";
      const isExact = uname === target || dname === target || uid === target;
      const isPartial = uname.startsWith(target) || dname.startsWith(target);
      if (isExact || isPartial) matches.push({ ws, session: s, exact: isExact });
    }
    matches.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
    return matches;
  }

  isOwnerName(name) { return String(name || "").toLowerCase() === this.getOwnerUsername().toLowerCase(); }
  isMod(name) { return this.moderators.has(String(name || "").toLowerCase()); }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;

    // صفحات إدارية
    if (path === "/reports") {
      const token = url.searchParams.get("token") || "";
      if (token !== this.getOwnerToken()) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ reports: this.reports.slice().reverse() }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
      });
    }

    if (path === "/reset-banned") {
      const token = url.searchParams.get("token") || "";
      if (token !== this.getOwnerToken()) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      const count = this.bannedUsers.size;
      this.bannedUsers.clear();
      await this.saveBanned();
      this.broadcast(JSON.stringify({ type: "system", message: "تم فك الحظر عن الجميع" }), null);
      return new Response(JSON.stringify({ success: true, cleared: count }), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (path === "/reports-view") {
      return new Response(HTML_VIEWER, {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      this.handleSession(server, ip);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(JSON.stringify({
      status: "active", online: this.sessions.size,
      cachedMessages: this.messages.length, banned: this.bannedUsers.size,
      moderators: Array.from(this.moderators),
      users: Array.from(this.sessions.values()).filter(s => s.username).map(s => s.username),
      time: new Date().toISOString(),
    }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  handleSession(webSocket, ip) {
    webSocket.accept();
    const session = {
      username: null, displayName: null, userId: null, ip,
      isOwner: false, isMod: false,
      rateCount: 0, rateReset: Date.now(),
      authDeadline: Date.now() + AUTH_TIMEOUT_MS,
      announced: false, lastSeen: Date.now(),
    };
    this.sessions.set(webSocket, session);
    this.startPing();

    try { webSocket.send(JSON.stringify({ type: "history", messages: this.messages })); } catch (e) {}

    webSocket.addEventListener("message", async (event) => {
      await this.ready;
      session.lastSeen = Date.now();
      let data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      if (!data || typeof data !== "object") return;

      if (data.type === "auth") {
        const token = this.getOwnerToken();
        if (token && typeof data.token === "string" && data.token === token) {
          session.isOwner = true;
          session.username = this.getOwnerUsername();
          try { webSocket.send(JSON.stringify({ type: "auth_ok" })); } catch (e) {}
        } else {
          session.isOwner = false;
          try { webSocket.send(JSON.stringify({ type: "auth_fail" })); } catch (e) {}
        }
        return;
      }

      if (typeof data.username === "string" && data.username.length > 0) {
        const uname = data.username.slice(0, MAX_USERNAME_LEN);
        const lower = uname.toLowerCase();
        if (typeof data.displayName === "string" && data.displayName.length > 0)
          session.displayName = data.displayName.slice(0, MAX_USERNAME_LEN);
        if (typeof data.userId === "number" || typeof data.userId === "string")
          session.userId = String(data.userId);

        if (this.bannedUsers.has(lower) && !session.isOwner) {
          try { webSocket.send(JSON.stringify({ error: "banned", reason: KICK_MESSAGE })); } catch (e) {}
          try { webSocket.close(); } catch (e) {}
          return;
        }
        if (uname === this.getOwnerUsername() && !session.isOwner) {
          try { webSocket.send(JSON.stringify({ type: "system", message: "اسم المالك محجوز." })); } catch (e) {}
          return;
        }
        session.username = uname;
        session.isMod = this.isMod(uname);

        if (!session.announced) {
          session.announced = true;
          const users = [];
          for (const [, s] of this.sessions.entries()) if (s.username) users.push(s.username);
          try { webSocket.send(JSON.stringify({ type: "presence", users, moderators: Array.from(this.moderators) })); } catch (e) {}
          this.broadcast(JSON.stringify({ type: "join", username: uname }), webSocket);
        }
      }

      if (data.type === "typing") {
        if (!session.username) return;
        this.broadcast(JSON.stringify({ type: "typing", username: session.username, typing: !!data.typing }), webSocket);
        return;
      }
      if (data.type === "seen") {
        if (!session.username) return;
        this.broadcast(JSON.stringify({ type: "seen", messageId: String(data.messageId || ""), username: session.username }), webSocket);
        return;
      }
      if (data.type === "pong" || data.type === "hello") return;

      // === تبليغ عن رسالة ===
      if (data.type === "report") {
        if (!session.username) return;
        const target = String(data.target || "").slice(0, MAX_USERNAME_LEN);
        const text = String(data.text || "").slice(0, MAX_MESSAGE_LEN);
        const reason = String(data.reason || "بدون سبب").slice(0, 200);
        if (!target || !text) return;
        this.reports.push({
          reporter: session.username, target, text, reason,
          time: Date.now(), id: data.messageId || null,
        });
        await this.saveReports();
        try { webSocket.send(JSON.stringify({ type: "system", message: "تم إرسال البلاغ للمالك ✅" })); } catch (e) {}
        return;
      }

      // === همس ===
      if (data.type === "whisper") {
        if (!session.username) { try { webSocket.send(JSON.stringify({ error: "no_username" })); } catch (e) {} return; }
        const body = String(data.message || "").slice(0, MAX_MESSAGE_LEN);
        const targetLower = String(data.target || "").toLowerCase().trim();
        if (!body || !targetLower) return;
        if (targetLower === session.username.toLowerCase() && !session.isOwner) return;
        if (this.containsLink(body)) { try { webSocket.send(JSON.stringify({ error: "links_not_allowed" })); } catch (e) {} return; }
        if (!this.checkRateLimit(session)) { try { webSocket.send(JSON.stringify({ error: "rate_limited" })); } catch (e) {} return; }

        const targets = [];
        for (const [ws, s] of this.sessions.entries())
          if (s.username && s.username.toLowerCase() === targetLower) targets.push({ ws, name: s.username });

        if (targets.length === 0) {
          try { webSocket.send(JSON.stringify({ type: "system", message: "اللاعب غير متصل." })); } catch (e) {}
          return;
        }
        const payload = JSON.stringify({
          type: "whisper", id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
          from: session.username, to: targets[0].name, message: body, created_at: Date.now(),
        });
        for (const t of targets) try { t.ws.send(payload); } catch (e) {}
        try { webSocket.send(payload); } catch (e) {}
        return;
      }

      // === /mod add /mod remove ===
      if (data.type === "mod_action") {
        if (!session.isOwner) { try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {} return; }
        const target = String(data.target || "").toLowerCase().trim();
        const action = data.action === "remove" ? "remove" : "add";
        if (!target) return;
        if (action === "add") { this.moderators.add(target); await this.saveMods(); }
        else { this.moderators.delete(target); await this.saveMods(); }
        // تحديث الحالة الفورية
        for (const [, s] of this.sessions.entries()) if (s.username) s.isMod = this.isMod(s.username);
        this.broadcast(JSON.stringify({ type: "mods", moderators: Array.from(this.moderators) }), null);
        try { webSocket.send(JSON.stringify({ type: "system", message: (action === "add" ? "تم إضافة مشرف: " : "تم إزالة مشرف: ") + target })); } catch (e) {}
        return;
      }

      // === kick / ban / unban (قادمة من الأوامر النصية) ===
      const rawMessage = String(data.message || "").slice(0, MAX_MESSAGE_LEN);
      const lowerMsg = rawMessage.toLowerCase();

      const isKick = lowerMsg.startsWith("/kick ") || lowerMsg === "/kick";
      const isBan = (lowerMsg.startsWith("/ban ") || lowerMsg === "/ban") && !lowerMsg.startsWith("/banned");
      const isUnban = lowerMsg.startsWith("/unban ");
      const isKickAll = lowerMsg.startsWith("/kickall");
      const isList = lowerMsg.startsWith("/list") || lowerMsg.startsWith("/users");

      if (isList) {
        if (!session.isOwner && !session.isMod) { try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {} return; }
        const list = [];
        for (const [, s] of this.sessions.entries())
          if (s.username) list.push(s.username + (s.userId ? " #" + s.userId : "") + (s.isMod ? " [مشرف]" : ""));
        try { webSocket.send(JSON.stringify({ type: "system", message: list.length ? "المتصلون: " + list.join(" | ") : "لا يوجد أحد" })); } catch (e) {}
        return;
      }

      if (isKickAll) {
        if (!session.isOwner) { try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {} return; }
        const reason = rawMessage.slice(8).trim() || KICK_MESSAGE;
        let count = 0;
        for (const [ws, s] of this.sessions.entries()) {
          if (ws === webSocket || !s.username || this.isOwnerName(s.username)) continue;
          try { ws.send(JSON.stringify({ error: "kicked", target: s.username, reason })); count++; } catch (e) {}
        }
        try { webSocket.send(JSON.stringify({ type: "system", message: "تم طرد " + count })); } catch (e) {}
        return;
      }

      if (isKick || isBan || isUnban) {
        // صلاحيات: kick → مالك+مشرف (لكن مشرف لا يطرد المالك). ban/unban → مالك فقط
        if (isBan || isUnban) {
          if (!session.isOwner) { try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {} return; }
        } else if (isKick) {
          if (!session.isOwner && !session.isMod) { try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {} return; }
        }

        const cmdLen = isKick ? 5 : isBan ? 4 : 6;
        const rest = rawMessage.slice(cmdLen).trim();
        const parts = rest.split(/\s+/).filter(Boolean);
        const targetName = parts[0];
        const reasonText = parts.slice(1).join(" ");
        if (!targetName) { try { webSocket.send(JSON.stringify({ type: "system", message: "الصيغة: /kick <اسم> [سبب]" })); } catch (e) {} return; }

        const targetLower = targetName.toLowerCase();
        const targetIsOwner = this.isOwnerName(targetLower);

        // مشرف لا يمكنه لمس المالك
        if (!session.isOwner && targetIsOwner) {
          try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {}
          return;
        }

        if (isUnban) {
          this.bannedUsers.delete(targetLower); await this.saveBanned();
          try { webSocket.send(JSON.stringify({ type: "system", message: "تم فك الحظر عن " + targetName })); } catch (e) {}
          return;
        }

        // if ban on self (owner test) → kick only, don't persist
        const isSelfBan = targetLower === (session.username || "").toLowerCase();
        const isOwnerSelfTest = session.isOwner && isSelfBan;

        if (isBan && !isOwnerSelfTest) {
          this.bannedUsers.add(targetLower);
          await this.saveBanned();
        }

        const finalReason = reasonText || KICK_MESSAGE;
        const matches = this.findSessionsByTarget(targetName);

        if (matches.length === 0) {
          try { webSocket.send(JSON.stringify({ type: "system", message: "اللاعب " + targetName + " غير متصل. تم تسجيل الحظر إن كان /ban." })); } catch (e) {}
          return;
        }

        for (const m of matches) {
          const isBanTarget = isBan && !isOwnerSelfTest;
          const errorType = isBanTarget ? "banned" : "kicked";
          try { m.ws.send(JSON.stringify({ error: errorType, target: m.session.username, reason: finalReason })); } catch (e) {}
          if (isBanTarget) try { m.ws.close(); } catch (e) {}
        }
        try { webSocket.send(JSON.stringify({ type: "system", message: (isBan ? "تم حظر " : "تم طرد ") + targetName })); } catch (e) {}
        return;
      }

      if (lowerMsg.startsWith("/help")) {
        try { webSocket.send(JSON.stringify({ type: "system", message: session.isOwner ? "المالك: /kick /ban /unban /kickall /list /mod" : session.isMod ? "مشرف: /kick /list" : "لا صلاحيات" })); } catch (e) {}
        return;
      }

      if (!session.username) { try { webSocket.send(JSON.stringify({ error: "no_username" })); } catch (e) {} return; }
      if (this.containsLink(rawMessage)) { try { webSocket.send(JSON.stringify({ error: "links_not_allowed" })); } catch (e) {} return; }
      if (!this.checkRateLimit(session)) { try { webSocket.send(JSON.stringify({ error: "rate_limited" })); } catch (e) {} return; }

      const msg = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
        username: session.username, message: rawMessage, created_at: Date.now(),
      };
      this.messages.push(msg);
      if (this.messages.length > HISTORY_LIMIT) this.messages.shift();
      this.broadcast(JSON.stringify({ type: "message", ...msg }), null);
    });

    webSocket.addEventListener("close", () => this.removeSession(webSocket));
    webSocket.addEventListener("error", () => this.removeSession(webSocket));
  }
}

const HTML_VIEWER = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>البلاغات</title>
<style>body{font-family:system-ui;background:#1a1c20;color:#e4e6ea;padding:20px;max-width:900px;margin:auto}
input,button{padding:10px;border-radius:0;border:1px solid #333;background:#252830;color:#fff;margin:4px 0}
table{width:100%;border-collapse:collapse;margin-top:16px}
th,td{padding:8px;border-bottom:1px solid #2a2d35;text-align:right;font-size:14px}
th{background:#23262e;color:#9aa0ab}
tr:hover{background:#22252d}
.tag{display:inline-block;padding:2px 6px;background:#3f64b2;font-size:11px}
h2{color:#fff}</style></head><body>
<h2>📋 البلاغات</h2>
<div><input id="tok" placeholder="كلمة سر المالك" style="width:60%"><button onclick="load()">عرض</button> <button onclick="reset()">مسح المحظورين</button></div>
<table><thead><tr><th>المُبلِّغ</th><th>الهدف</th><th>الرسالة</th><th>السبب</th><th>الوقت</th></tr></thead><tbody id="tb"></tbody></table>
<script>
const url = location.origin;
async function load() {
  const tok = document.getElementById('tok').value.trim();
  const r = await fetch(url + '/reports?token=' + encodeURIComponent(tok));
  const d = await r.json();
  const tb = document.getElementById('tb'); tb.innerHTML = '';
  if (!d.reports) { alert('خطأ: ' + (d.error || 'غير مصرح')); return; }
  for (const x of d.reports) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+x.reporter+'</td><td>'+x.target+'</td><td>'+x.text.replace(/</g,'&lt;')+'</td><td>'+x.reason+'</td><td>'+new Date(x.time).toLocaleString('ar')+'</td>';
    tb.appendChild(tr);
  }
}
async function reset() {
  const tok = document.getElementById('tok').value.trim();
  if (!confirm('مسح كل المحظورين؟')) return;
  const r = await fetch(url + '/reset-banned?token=' + encodeURIComponent(tok));
  const d = await r.json();
  alert(d.success ? 'تم مسح ' + d.cleared : 'فشل: ' + d.error);
}
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/script" || url.pathname === "/chat.lua") return serveScript();
    const id = env.CHAT_ROOM.idFromName("global-room");
    const stub = env.CHAT_ROOM.get(id);
    return stub.fetch(request);
  },
};
