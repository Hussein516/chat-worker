import { DurableObject } from "cloudflare:workers";

const KICK_MESSAGE = "تم طردك بسبب مخالفة قوانين الشات";
const HISTORY_LIMIT = 30;
const MAX_REPORTS = 200;
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

const EMBEDDED_SCRIPT_FALLBACK =
  "warn('[Chat] فشل تحميل السكربت من Worker')\n";

function reply(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {}
}

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
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

export class ChatRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.env = env;
    this.sessions = new Map();
    this.messages = [];
    this.bannedUsers = new Set();
    this.admins = new Set();
    this.gmuted = new Set();
    this.reports = [];
    this.pingTimer = null;
    this.ready = this.loadState();
  }

  async loadState() {
    try {
      const banned = await this.ctx.storage.get("banned");
      if (Array.isArray(banned)) {
        this.bannedUsers = new Set(banned.map((u) => String(u).toLowerCase()));
      }
      const admins = await this.ctx.storage.get("admins");
      if (Array.isArray(admins)) {
        this.admins = new Set(admins.map((u) => String(u).toLowerCase()));
      }
      const gmuted = await this.ctx.storage.get("gmuted");
      if (Array.isArray(gmuted)) {
        this.gmuted = new Set(gmuted.map((u) => String(u).toLowerCase()));
      }
      const reports = await this.ctx.storage.get("reports");
      if (Array.isArray(reports)) {
        this.reports = reports;
      }
    } catch (e) {
      this.bannedUsers = new Set();
    }
  }

  async saveKey(key, value) {
    try {
      await this.ctx.storage.put(key, value);
    } catch (e) {}
  }

  async saveBanned() {
    await this.saveKey("banned", Array.from(this.bannedUsers));
  }

  async saveAdmins() {
    await this.saveKey("admins", Array.from(this.admins));
  }

  async saveGmuted() {
    await this.saveKey("gmuted", Array.from(this.gmuted));
  }

  async saveReports() {
    await this.saveKey("reports", this.reports);
  }

  containsLink(text) {
    if (!text) return false;
    return /(?:https?:\/\/|www\.)\S+|\bdiscord\.gg\/\S+|\b(?:t\.me|telegram\.me)\/\S+/i.test(
      text
    );
  }

  getOwnerUsername() {
    return (this.env && this.env.OWNER_USERNAME) || "maalek_1234";
  }

  getOwnerToken() {
    return (this.env && this.env.OWNER_TOKEN) || "";
  }

  normalizeToken(t) {
    return String(t || "").normalize("NFC");
  }

  ownerLower() {
    return this.getOwnerUsername().toLowerCase();
  }

  roleOfName(name) {
    const n = String(name || "").toLowerCase();
    if (n === this.ownerLower()) return "owner";
    if (this.admins.has(n)) return "admin";
    return "member";
  }

  roleOfSession(s) {
    if (s.isOwner) return "owner";
    return this.roleOfName(s.username);
  }

  canAct(actor, actorRole, target) {
    if (actorRole === "owner") return true;
    if (actorRole === "admin") {
      return target !== actor && this.roleOfSession(target) === "member";
    }
    return false;
  }

  findExact(name) {
    const n = String(name || "").toLowerCase();
    for (const [, s] of this.sessions) {
      if (s.username && s.username.toLowerCase() === n) return s;
    }
    return null;
  }

  pushRole(lowerName, shownName) {
    const role = this.roleOfName(lowerName);
    for (const [ws, s] of this.sessions) {
      if (s.username && s.username.toLowerCase() === lowerName && !s.isOwner) {
        reply(ws, { type: "role", role });
      }
    }
    this.broadcast(
      JSON.stringify({ type: "role_update", username: shownName, role }),
      null
    );
  }

  removeSession(ws) {
    const s = this.sessions.get(ws);
    if (!s) return;
    this.sessions.delete(ws);
    if (s.announced && s.username) {
      this.broadcast(
        JSON.stringify({ type: "leave", username: s.username }),
        null
      );
    }
  }

  broadcast(payload, excludeWs) {
    const dead = [];
    for (const [ws] of this.sessions) {
      if (ws === excludeWs) continue;
      try {
        ws.send(payload);
      } catch (e) {
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      try {
        ws.close();
      } catch (e) {}
      this.removeSession(ws);
    }
  }

  startPing() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (this.sessions.size === 0) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        return;
      }
      const now = Date.now();
      const stale = [];
      for (const [ws, s] of this.sessions) {
        if (now - s.lastSeen > STALE_MS) stale.push(ws);
      }
      for (const ws of stale) {
        try {
          ws.close();
        } catch (e) {}
        this.removeSession(ws);
      }
      this.broadcast(JSON.stringify({ type: "ping", t: Date.now() }), null);
    }, PING_INTERVAL_MS);
  }

  checkRateLimit(session) {
    const now = Date.now();
    if (now - session.rateReset > RATE_LIMIT_WINDOW_MS) {
      session.rateCount = 0;
      session.rateReset = now;
    }
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
      if (isExact || isPartial) {
        matches.push({ ws, session: s, exact: isExact });
      }
    }
    matches.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
    return matches;
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;
    const panelKey = (this.env && this.env.PANEL_KEY) || "";
    const keyOk = panelKey !== "" && url.searchParams.get("key") === panelKey;

    if (path === "/reports") {
      if (!keyOk) return new Response("Not found", { status: 404 });
      const lines = ["Reports: " + this.reports.length, ""];
      for (const r of this.reports.slice().reverse()) {
        lines.push(
          "[" +
            new Date(r.at).toISOString() +
            "] " +
            r.reporter +
            " -> " +
            r.target +
            " : " +
            String(r.text).replace(/\s+/g, " ")
        );
      }
      return new Response(lines.join("\n"), {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (path === "/reset-bans" || path === "/clear-banned") {
      if (!keyOk) return new Response("Not found", { status: 404 });
      const count = this.bannedUsers.size;
      this.bannedUsers.clear();
      await this.saveBanned();
      return new Response("Bans reset: " + count, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      this.handleSession(server, ip);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(
      JSON.stringify({
        status: "active",
        online: this.sessions.size,
        cachedMessages: this.messages.length,
        banned: this.bannedUsers.size,
        users: Array.from(this.sessions.values())
          .filter((s) => s.username)
          .map((s) => s.username),
        time: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }
    );
  }

  handleSession(webSocket, ip) {
    webSocket.accept();

    const session = {
      username: null,
      displayName: null,
      userId: null,
      ip,
      isOwner: false,
      rateCount: 0,
      rateReset: Date.now(),
      authDeadline: Date.now() + AUTH_TIMEOUT_MS,
      announced: false,
      lastSeen: Date.now(),
    };

    this.sessions.set(webSocket, session);
    this.startPing();

    reply(webSocket, { type: "history", messages: this.messages });

    webSocket.addEventListener("message", async (event) => {
      await this.ready;
      session.lastSeen = Date.now();

      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (!data || typeof data !== "object") return;

      if (data.type === "auth") {
        const token = this.normalizeToken(this.getOwnerToken());
        if (
          token &&
          typeof data.token === "string" &&
          this.normalizeToken(data.token) === token
        ) {
          session.isOwner = true;
          session.username = this.getOwnerUsername();
          reply(webSocket, { type: "auth_ok" });
          reply(webSocket, { type: "role", role: "owner" });
        } else {
          session.isOwner = false;
          reply(webSocket, { type: "auth_fail" });
        }
        return;
      }

      if (typeof data.username === "string" && data.username.length > 0) {
        const uname = data.username.slice(0, MAX_USERNAME_LEN);
        const lower = uname.toLowerCase();

        if (typeof data.displayName === "string" && data.displayName.length > 0) {
          session.displayName = data.displayName.slice(0, MAX_USERNAME_LEN);
        }
        if (typeof data.userId === "number" || typeof data.userId === "string") {
          session.userId = String(data.userId);
        }

        if (this.bannedUsers.has(lower) && !session.isOwner) {
          reply(webSocket, { error: "banned" });
          try {
            webSocket.close();
          } catch (e) {}
          return;
        }

        if (uname === this.getOwnerUsername() && !session.isOwner) {
          reply(webSocket, {
            type: "system",
            message: "اسم المالك محجوز. اختر اسمًا آخر.",
          });
          return;
        }

        session.username = uname;

        if (!session.announced) {
          session.announced = true;
          const users = [];
          const roles = {};
          for (const [, s] of this.sessions.entries()) {
            if (s.username) {
              users.push(s.username);
              const r = this.roleOfSession(s);
              if (r !== "member") roles[s.username.toLowerCase()] = r;
            }
          }
          reply(webSocket, { type: "presence", users, roles });
          reply(webSocket, { type: "role", role: this.roleOfSession(session) });
          this.broadcast(
            JSON.stringify({
              type: "join",
              username: uname,
              role: this.roleOfSession(session),
            }),
            webSocket
          );
        }
      }

      if (data.type === "typing") {
        if (!session.username) return;
        if (!session.isOwner && this.gmuted.has(session.username.toLowerCase())) return;
        this.broadcast(
          JSON.stringify({
            type: "typing",
            username: session.username,
            typing: !!data.typing,
          }),
          webSocket
        );
        return;
      }

      if (data.type === "seen") {
        if (!session.username) return;
        this.broadcast(
          JSON.stringify({
            type: "seen",
            messageId: String(data.messageId || ""),
            username: session.username,
          }),
          webSocket
        );
        return;
      }

      if (data.type === "pong") return;
      if (data.type === "hello") return;

      if (data.type === "whisper") {
        if (!session.username) {
          reply(webSocket, { error: "no_username" });
          return;
        }

        const body = String(data.message || "").slice(0, MAX_MESSAGE_LEN);
        const targetLower = String(data.target || "").toLowerCase().trim();
        if (!body || !targetLower) return;

        if (targetLower === session.username.toLowerCase() && !session.isOwner) return;

        if (this.containsLink(body)) {
          reply(webSocket, { error: "links_not_allowed" });
          return;
        }

        if (!this.checkRateLimit(session)) {
          reply(webSocket, { error: "rate_limited" });
          return;
        }

        const targets = [];
        for (const [ws, s] of this.sessions.entries()) {
          if (s.username && s.username.toLowerCase() === targetLower) {
            targets.push({ ws, name: s.username });
          }
        }

        if (targets.length === 0) {
          reply(webSocket, { type: "system", message: "اللاعب غير متصل حاليًا." });
          return;
        }

        const payload = JSON.stringify({
          type: "whisper",
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
          from: session.username,
          to: targets[0].name,
          message: body,
          created_at: Date.now(),
        });

        const silenced =
          !session.isOwner && this.gmuted.has(session.username.toLowerCase());
        let selfIncluded = false;
        for (const t of targets) {
          if (t.ws === webSocket) selfIncluded = true;
          if (!silenced) {
            try {
              t.ws.send(payload);
            } catch (e) {}
          }
        }
        if (!selfIncluded || silenced) {
          try {
            webSocket.send(payload);
          } catch (e) {}
        }
        return;
      }

      if (data.type === "report") {
        if (!session.username) {
          reply(webSocket, { error: "no_username" });
          return;
        }
        const target = String(data.target || "").slice(0, MAX_USERNAME_LEN);
        const text = String(data.text || "").slice(0, MAX_MESSAGE_LEN);
        if (!target || !text) return;
        if (target.toLowerCase() === this.ownerLower()) {
          reply(webSocket, {
            type: "system",
            message: "لا يمكن الإبلاغ عن هذا المستخدم.",
          });
          return;
        }
        if (!this.checkRateLimit(session)) {
          reply(webSocket, { error: "rate_limited" });
          return;
        }
        this.reports.push({
          at: Date.now(),
          reporter: session.username,
          target,
          text,
        });
        if (this.reports.length > MAX_REPORTS) this.reports.shift();
        await this.saveReports();
        reply(webSocket, { type: "system", message: "تم إرسال البلاغ." });
        return;
      }

      if (data.type === "unban") {
        if (!session.isOwner) {
          reply(webSocket, { error: "not_allowed" });
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;
        this.bannedUsers.delete(target);
        await this.saveBanned();
        reply(webSocket, { type: "system", message: "تم فك الحظر عن " + target });
        return;
      }

      if (data.type === "ban") {
        if (!session.isOwner) {
          reply(webSocket, { error: "not_allowed" });
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target || target === this.ownerLower()) return;
        this.bannedUsers.add(target);
        await this.saveBanned();
        reply(webSocket, { type: "system", message: "تم حظر " + target });
        return;
      }

      const rawMessage = String(data.message || "").slice(0, MAX_MESSAGE_LEN);
      const lowerMsg = rawMessage.toLowerCase();

      const isKick = lowerMsg.startsWith("/kick");
      const isBan = lowerMsg.startsWith("/ban") && !lowerMsg.startsWith("/banned");
      const isUnban = lowerMsg.startsWith("/unban");
      const isList = lowerMsg.startsWith("/list") || lowerMsg.startsWith("/users");
      const isKickAll = lowerMsg.startsWith("/kickall");
      const isMakeAdmin = lowerMsg.startsWith("/makeadmin");
      const isDemote = lowerMsg.startsWith("/demote");
      const isGMute = lowerMsg.startsWith("/gmute");
      const isGUnmute = lowerMsg.startsWith("/gunmute");

      if (isMakeAdmin || isDemote || isGMute || isGUnmute) {
        if (!session.isOwner) {
          reply(webSocket, { error: "not_allowed" });
          return;
        }
        const cmdLen = isMakeAdmin ? 10 : isDemote ? 7 : isGMute ? 6 : 8;
        const targetName = rawMessage
          .slice(cmdLen)
          .trim()
          .split(/\s+/)
          .filter(Boolean)[0];
        if (!targetName) {
          reply(webSocket, {
            type: "system",
            message: "الصيغة: /makeadmin أو /demote أو /gmute أو /gunmute <الاسم>",
          });
          return;
        }
        const exact = this.findExact(targetName);
        const shownName = exact ? exact.username : targetName;
        const t = shownName.toLowerCase();
        if (t === this.ownerLower() || (exact && exact.isOwner)) {
          reply(webSocket, {
            type: "system",
            message: "لا يمكن تطبيق هذا الأمر على المالك.",
          });
          return;
        }
        if (isMakeAdmin) {
          this.admins.add(t);
          await this.saveAdmins();
          this.pushRole(t, shownName);
          reply(webSocket, { type: "system", message: "تم تعيين " + shownName + " مشرفًا." });
        } else if (isDemote) {
          this.admins.delete(t);
          await this.saveAdmins();
          this.pushRole(t, shownName);
          reply(webSocket, { type: "system", message: "تمت إزالة " + shownName + " من الإشراف." });
        } else if (isGMute) {
          this.gmuted.add(t);
          await this.saveGmuted();
          reply(webSocket, { type: "system", message: "تم كتم " + shownName + " للجميع." });
        } else {
          this.gmuted.delete(t);
          await this.saveGmuted();
          reply(webSocket, { type: "system", message: "تم إلغاء الكتم العام عن " + shownName + "." });
        }
        return;
      }

      if (isList) {
        if (!session.isOwner) {
          reply(webSocket, { error: "not_allowed" });
          return;
        }
        const list = [];
        for (const [, s] of this.sessions.entries()) {
          if (s.username) {
            let entry = s.username;
            if (s.displayName && s.displayName !== s.username)
              entry += " [" + s.displayName + "]";
            if (s.userId) entry += " #" + s.userId;
            const r = this.roleOfSession(s);
            if (r === "admin") entry += " (مشرف)";
            list.push(entry);
          }
        }
        reply(webSocket, {
          type: "system",
          message:
            list.length > 0
              ? "المتصلون (" + list.length + "): " + list.join(" | ")
              : "مافيش حد متصل حاليًا.",
        });
        return;
      }

      if (isKickAll) {
        if (!session.isOwner) {
          reply(webSocket, { error: "not_allowed" });
          return;
        }
        const reason = rawMessage.slice(8).trim() || KICK_MESSAGE;
        let count = 0;
        for (const [ws, s] of this.sessions.entries()) {
          if (ws === webSocket) continue;
          if (!s.username) continue;
          try {
            ws.send(
              JSON.stringify({
                error: "kicked",
                target: s.username,
                reason: reason,
                style: "kick",
              })
            );
            count++;
          } catch (e) {}
        }
        reply(webSocket, {
          type: "system",
          message: "تم إرسال أمر الطرد لـ " + count + " لاعب.",
        });
        return;
      }

      if (isKick || isBan || isUnban) {
        const actorRole = this.roleOfSession(session);
        if (actorRole === "member" || (actorRole === "admin" && !isKick)) {
          reply(webSocket, { error: "not_allowed" });
          return;
        }

        const cmdLen = isKick ? 5 : isBan ? 4 : 6;
        const rest = rawMessage.slice(cmdLen).trim();
        const parts = rest.split(/\s+/).filter(Boolean);
        const targetName = parts[0];
        const reasonText = parts.slice(1).join(" ");

        if (!targetName) {
          reply(webSocket, {
            type: "system",
            message:
              "الصيغة: /kick أو /ban أو /unban <الاسم> <السبب اختياري>\n/list لعرض المتصلين",
          });
          return;
        }

        const targetLower = targetName.toLowerCase();

        if (isUnban) {
          this.bannedUsers.delete(targetLower);
          await this.saveBanned();
          reply(webSocket, { type: "system", message: "تم فك الحظر عن " + targetName });
          return;
        }

        const finalReason = reasonText || KICK_MESSAGE;
        const found = this.findSessionsByTarget(targetName);
        const matches = found.filter((m) =>
          this.canAct(session, actorRole, m.session)
        );

        if (found.length > 0 && matches.length === 0) {
          reply(webSocket, { error: "not_allowed" });
          return;
        }

        if (isBan) {
          if (matches.length > 0) {
            for (const m of matches) {
              if (!m.session.isOwner) {
                this.bannedUsers.add(m.session.username.toLowerCase());
              }
            }
          } else if (targetLower !== this.ownerLower()) {
            this.bannedUsers.add(targetLower);
          }
          await this.saveBanned();
        }

        if (matches.length === 0) {
          reply(webSocket, {
            type: "system",
            message: isBan
              ? "تم حظر " + targetName + " (غير متصل حاليًا)."
              : "اللاعب " + targetName + " غير متصل حاليًا. استخدم /list لعرض المتصلين.",
          });
          return;
        }

        const style = actorRole === "owner" ? (isBan ? "ban" : "kick") : "plain";

        for (const m of matches) {
          reply(m.ws, {
            error: "kicked",
            target: m.session.username,
            reason: finalReason,
            style,
          });
          if (isBan && !m.session.isOwner) {
            try {
              m.ws.close();
            } catch (e) {}
          }
        }

        const names = matches.map((m) => m.session.username).join(", ");
        reply(webSocket, {
          type: "system",
          message:
            (isBan ? "تم حظر: " : "تم طرد: ") +
            names +
            (reasonText ? " — السبب: " + reasonText : ""),
        });
        return;
      }

      if (lowerMsg.startsWith("/help")) {
        const role = this.roleOfSession(session);
        reply(webSocket, {
          type: "system",
          message:
            role === "owner"
              ? "الأوامر: /kick /ban /unban /kickall /list /makeadmin /demote /gmute /gunmute"
              : role === "admin"
              ? "الأمر المتاح: /kick"
              : "ما عندكش صلاحيات إدارية.",
        });
        return;
      }

      if (!session.username) {
        reply(webSocket, { error: "no_username" });
        return;
      }

      if (this.containsLink(rawMessage)) {
        reply(webSocket, { error: "links_not_allowed" });
        return;
      }

      if (!this.checkRateLimit(session)) {
        reply(webSocket, { error: "rate_limited" });
        return;
      }

      const msg = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
        username: session.username,
        message: rawMessage,
        role: this.roleOfSession(session),
        created_at: Date.now(),
      };

      if (!session.isOwner && this.gmuted.has(session.username.toLowerCase())) {
        reply(webSocket, { type: "message", ...msg });
        return;
      }

      this.messages.push(msg);
      if (this.messages.length > HISTORY_LIMIT) this.messages.shift();

      this.broadcast(JSON.stringify({ type: "message", ...msg }), null);
    });

    webSocket.addEventListener("close", () => {
      this.removeSession(webSocket);
    });

    webSocket.addEventListener("error", () => {
      this.removeSession(webSocket);
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/script" || url.pathname === "/chat.lua") {
      return serveScript();
    }

    const id = env.CHAT_ROOM.idFromName("global-room");
    const stub = env.CHAT_ROOM.get(id);
    return stub.fetch(request);
  },
};
