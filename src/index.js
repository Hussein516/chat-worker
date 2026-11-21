import { DurableObject } from "cloudflare:workers";

const KICK_MESSAGE = "تم طردك بسبب مخالفة قوانين الشات";
const HISTORY_LIMIT = 30;
const REPORTS_LIMIT = 300;
const RATE_LIMIT_PER_USER = 15;
const RATE_LIMIT_WINDOW_MS = 10000;
const PING_INTERVAL_MS = 25000;
const STALE_MS = 70000;
const MAX_USERNAME_LEN = 32;
const MAX_MESSAGE_LEN = 300;
const MAX_REASON_LEN = 120;

const SCRIPT_SOURCES = [
  "https://gist.githubusercontent.com/Hussein516/639729fccb66180848cf5364ce71870f/raw/626e5f6c464b0ea79530d983cb5fd70ab8c056b1/chat.lua",
  "https://cdn.jsdelivr.net/gh/Hussein516/Script@main/Idk",
  "https://raw.githubusercontent.com/Hussein516/Script/main/Idk",
];

const EMBEDDED_SCRIPT_FALLBACK =
  "warn('[Chat] فشل تحميل السكربت من Worker')\n";

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
    this.mutedUsers = new Set();
    this.reports = [];
    this.pingTimer = null;
    this.ready = this.loadState();
  }

  async loadState() {
    try {
      const stored = await this.ctx.storage.get("banned");
      if (Array.isArray(stored)) {
        this.bannedUsers = new Set(stored.map((u) => String(u).toLowerCase()));
      }
      const storedAdmins = await this.ctx.storage.get("admins");
      if (Array.isArray(storedAdmins)) {
        this.admins = new Set(storedAdmins.map((u) => String(u).toLowerCase()));
      }
      const storedMuted = await this.ctx.storage.get("muted");
      if (Array.isArray(storedMuted)) {
        this.mutedUsers = new Set(storedMuted.map((u) => String(u).toLowerCase()));
      }
      const storedReports = await this.ctx.storage.get("reports");
      if (Array.isArray(storedReports)) {
        this.reports = storedReports.slice(-REPORTS_LIMIT);
      }
    } catch (e) {}
  }

  async saveBanned() {
    try {
      await this.ctx.storage.put("banned", Array.from(this.bannedUsers));
    } catch (e) {}
  }

  async saveAdmins() {
    try {
      await this.ctx.storage.put("admins", Array.from(this.admins));
    } catch (e) {}
  }

  async saveMuted() {
    try {
      await this.ctx.storage.put("muted", Array.from(this.mutedUsers));
    } catch (e) {}
  }

  async saveReports() {
    try {
      await this.ctx.storage.put("reports", this.reports.slice(-REPORTS_LIMIT));
    } catch (e) {}
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

  isMutedSession(s) {
    return !!(s.username && this.mutedUsers.has(s.username.toLowerCase()) && !s.isOwner);
  }

  isContentType(t) {
    return (
      t === "message" ||
      t === "typing" ||
      t === "join" ||
      t === "leave" ||
      t === "whisper" ||
      t === "presence" ||
      t === "owner_tag"
    );
  }

  broadcast(payload, excludeWs) {
    let type = null;
    try {
      type = JSON.parse(payload).type;
    } catch (e) {}
    const dead = [];
    for (const [ws, s] of this.sessions) {
      if (ws === excludeWs) continue;
      if (type && this.isContentType(type) && this.isMutedSession(s)) continue;
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

  kickTarget(webSocket, session, targetName, reason, anim) {
    const finalReason = String(reason || KICK_MESSAGE).slice(0, MAX_REASON_LEN);
    const matches = this.findSessionsByTarget(targetName);
    let kicked = 0;
    for (const m of matches) {
      const t = m.session;
      if (!session.isOwner) {
        if (t.isOwner) continue;
        if (t.username && t.username.toLowerCase() === this.getOwnerUsername().toLowerCase()) continue;
        if (t.username && this.admins.has(t.username.toLowerCase())) continue;
      }
      try {
        m.ws.send(
          JSON.stringify({
            error: "kicked",
            target: t.username,
            reason: finalReason,
            anim: anim,
          })
        );
        kicked++;
      } catch (e) {}
    }
    return { kicked, matches };
  }

  reportsText() {
    if (this.reports.length === 0) {
      return "لا توجد بلاغات.\n";
    }
    const lines = this.reports.map((r) => {
      const time = new Date(r.time || Date.now()).toISOString();
      return (
        "[" + time + "] المُبلِّغ: " + r.reporter +
        " | المُبلَّغ عنه: " + r.target +
        " | الرسالة: " + r.message +
        (r.messageId ? " (id: " + r.messageId + ")" : "")
      );
    });
    return lines.join("\n") + "\n";
  }

  async fetch(request) {
    await this.ready;
    const path = new URL(request.url).pathname;

    if (path === "/clear-banned") {
      const count = this.bannedUsers.size;
      this.bannedUsers.clear();
      await this.saveBanned();
      return new Response(
        JSON.stringify({
          success: true,
          cleared: count,
          message: "تم مسح " + count + " محظور",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }
      );
    }

    if (path === "/clear-reports") {
      const count = this.reports.length;
      this.reports = [];
      await this.saveReports();
      return new Response(
        JSON.stringify({ success: true, cleared: count }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }
      );
    }

    if (path === "/reports") {
      return new Response(this.reportsText(), {
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
        admins: Array.from(this.admins),
        muted: Array.from(this.mutedUsers),
        reports: this.reports.length,
        users: Array.from(this.sessions.values())
          .filter((s) => s.username)
          .map((s) => s.username),
        games: Array.from(this.sessions.values())
          .filter((s) => s.username && s.placeId)
          .map((s) => ({
            username: s.username,
            placeId: s.placeId,
            jobId: s.jobId,
          })),
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
      placeId: null,
      jobId: null,
      ip,
      isOwner: false,
      ownerAnnounced: false,
      muteNotified: false,
      rateCount: 0,
      rateReset: Date.now(),
      announced: false,
      lastSeen: Date.now(),
    };

    this.sessions.set(webSocket, session);
    this.startPing();

    try {
      webSocket.send(JSON.stringify({ type: "history", messages: this.messages }));
    } catch (e) {}

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
        const token = this.getOwnerToken();
        if (token && typeof data.token === "string" && data.token === token) {
          session.isOwner = true;
          session.username = this.getOwnerUsername();
          try {
            webSocket.send(JSON.stringify({ type: "auth_ok" }));
          } catch (e) {}
        } else {
          session.isOwner = false;
          try {
            webSocket.send(JSON.stringify({ type: "auth_fail" }));
          } catch (e) {}
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
        if (data.placeId !== undefined && data.placeId !== null) {
          session.placeId = String(data.placeId);
        }
        if (typeof data.jobId === "string" && data.jobId.length > 0) {
          session.jobId = data.jobId.slice(0, 100);
        }

        if (this.bannedUsers.has(lower) && !session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "banned" }));
          } catch (e) {}
          try {
            webSocket.close();
          } catch (e) {}
          return;
        }

        if (uname === this.getOwnerUsername() && !session.isOwner) {
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message: "اسم المالك محجوز. اختر اسمًا آخر.",
              })
            );
          } catch (e) {}
          return;
        }

        session.username = uname;

        if (!session.announced) {
          session.announced = true;
          const users = [];
          for (const [, s] of this.sessions.entries()) {
            if (s.username) users.push(s.username);
          }
          try {
            webSocket.send(JSON.stringify({ type: "presence", users }));
          } catch (e) {}
          this.broadcast(
            JSON.stringify({ type: "join", username: uname }),
            webSocket
          );
        }

        if (session.isOwner && !session.ownerAnnounced) {
          session.ownerAnnounced = true;
          this.broadcast(JSON.stringify({ type: "owner_tag", username: uname }), null);
        }
      }

      if (!session.username) {
        if (data.type !== "pong" && data.type !== "hello") {
          try {
            webSocket.send(JSON.stringify({ error: "no_username" }));
          } catch (e) {}
        }
        return;
      }

      if (this.mutedUsers.has(session.username.toLowerCase()) && !session.isOwner) {
        if (!session.muteNotified) {
          session.muteNotified = true;
          try {
            webSocket.send(
              JSON.stringify({ type: "system", message: "تم كتمك من الشات." })
            );
          } catch (e) {}
        }
        return;
      }

      if (data.type === "typing") {
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
        const body = String(data.message || "").slice(0, MAX_MESSAGE_LEN);
        const targetLower = String(data.target || "").toLowerCase().trim();
        if (!body || !targetLower) return;

        if (targetLower === session.username.toLowerCase() && !session.isOwner) return;

        if (this.containsLink(body)) {
          try {
            webSocket.send(JSON.stringify({ error: "links_not_allowed" }));
          } catch (e) {}
          return;
        }

        if (!this.checkRateLimit(session)) {
          try {
            webSocket.send(JSON.stringify({ error: "rate_limited" }));
          } catch (e) {}
          return;
        }

        const targets = [];
        for (const [ws, s] of this.sessions.entries()) {
          if (s.username && s.username.toLowerCase() === targetLower) {
            targets.push({ ws, name: s.username });
          }
        }

        if (targets.length === 0) {
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message: "اللاعب غير متصل حاليًا.",
              })
            );
          } catch (e) {}
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

        for (const t of targets) {
          const s = this.sessions.get(t.ws);
          if (s && this.isMutedSession(s)) continue;
          try {
            t.ws.send(payload);
          } catch (e) {}
        }
        try {
          webSocket.send(payload);
        } catch (e) {}
        return;
      }

      if (data.type === "report") {
        const rep = {
          time: Date.now(),
          reporter: session.username,
          target: String(data.target || "").slice(0, MAX_USERNAME_LEN),
          message: String(data.message || "").slice(0, MAX_MESSAGE_LEN),
          messageId: String(data.messageId || "").slice(0, 40),
        };
        if (rep.target && rep.message) {
          this.reports.push(rep);
          if (this.reports.length > REPORTS_LIMIT) {
            this.reports = this.reports.slice(-REPORTS_LIMIT);
          }
          await this.saveReports();
          const notice = JSON.stringify({
            type: "system",
            message:
              "بلاغ جديد: " + rep.reporter + " أبلغ عن " + rep.target + ": " + rep.message,
          });
          for (const [ws, s] of this.sessions.entries()) {
            if (s.isOwner) {
              try {
                ws.send(notice);
              } catch (e) {}
            }
          }
          try {
            webSocket.send(
              JSON.stringify({ type: "system", message: "تم إرسال البلاغ." })
            );
          } catch (e) {}
        }
        return;
      }

      if (data.type === "servermute" || data.type === "serverunmute") {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;
        if (target === this.getOwnerUsername().toLowerCase()) {
          try {
            webSocket.send(
              JSON.stringify({ type: "system", message: "لا يمكن كتم المالك." })
            );
          } catch (e) {}
          return;
        }
        if (data.type === "servermute") {
          this.mutedUsers.add(target);
        } else {
          this.mutedUsers.delete(target);
        }
        await this.saveMuted();
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message:
                (data.type === "servermute" ? "تم كتم " : "تم إلغاء كتم ") + target,
            })
          );
        } catch (e) {}
        return;
      }

      if (data.type === "admin_add" || data.type === "admin_remove") {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;
        if (target === this.getOwnerUsername().toLowerCase()) {
          try {
            webSocket.send(
              JSON.stringify({ type: "system", message: "لا يمكن تعديل صلاحيات المالك." })
            );
          } catch (e) {}
          return;
        }
        if (data.type === "admin_add") {
          this.admins.add(target);
        } else {
          this.admins.delete(target);
        }
        await this.saveAdmins();
        this.broadcast(
          JSON.stringify({ type: "admins", admins: Array.from(this.admins) }),
          null
        );
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message:
                (data.type === "admin_add" ? "تم تعيين مشرف: " : "تمت إزالة مشرف: ") + target,
            })
          );
        } catch (e) {}
        return;
      }

      if (data.type === "joininfo") {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const matches = this.findSessionsByTarget(data.target);
        const m = matches.find((x) => x.session.placeId && x.session.jobId);
        if (m) {
          try {
            webSocket.send(
              JSON.stringify({
                type: "joininfo",
                username: m.session.username,
                placeId: m.session.placeId,
                jobId: m.session.jobId,
              })
            );
          } catch (e) {}
        } else {
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message: "لا توجد معلومات سيرفر لهذا اللاعب.",
              })
            );
          } catch (e) {}
        }
        return;
      }

      if (data.type === "kick") {
        const isAdminUser =
          session.username && this.admins.has(session.username.toLowerCase());
        if (!session.isOwner && !isAdminUser) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const target = String(data.target || "").trim();
        if (!target) return;
        const reason = String(data.reason || KICK_MESSAGE).slice(0, MAX_REASON_LEN);
        const anim = session.isOwner ? "kick" : "none";
        const res = this.kickTarget(webSocket, session, target, reason, anim);
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message:
                res.kicked > 0
                  ? "تم طرد: " + res.matches.map((x) => x.session.username).join(", ")
                  : "لم يتم العثور على لاعب للطرد (أو محمي).",
            })
          );
        } catch (e) {}
        return;
      }

      if (data.type === "ban" || data.type === "unban") {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;

        if (data.type === "unban") {
          this.bannedUsers.delete(target);
          await this.saveBanned();
          try {
            webSocket.send(
              JSON.stringify({ type: "system", message: "تم فك الحظر عن " + target })
            );
          } catch (e) {}
          return;
        }

        const matches = this.findSessionsByTarget(data.target);
        const isOwnerTarget =
          target === this.getOwnerUsername().toLowerCase() ||
          matches.some((m) => m.session.isOwner);

        if (!isOwnerTarget) {
          this.bannedUsers.add(target);
          await this.saveBanned();
        }

        for (const m of matches) {
          try {
            m.ws.send(
              JSON.stringify({
                error: "kicked",
                target: m.session.username,
                reason: KICK_MESSAGE,
                anim: "ban",
              })
            );
          } catch (e) {}
          try {
            m.ws.close();
          } catch (e) {}
        }

        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message: isOwnerTarget
                ? "وضع تجريبي: تم تشغيل أنميشن الحظر بدون حظر فعلي."
                : "تم حظر " +
                    target +
                    (matches.length > 0
                      ? " وطرد: " + matches.map((x) => x.session.username).join(", ")
                      : ""),
            })
          );
        } catch (e) {}
        return;
      }

      const rawMessage = String(data.message || "").slice(0, MAX_MESSAGE_LEN);
      const lowerMsg = rawMessage.toLowerCase();

      const isKick = lowerMsg.startsWith("/kick");
      const isBan = lowerMsg.startsWith("/ban") && !lowerMsg.startsWith("/banned");
      const isUnban = lowerMsg.startsWith("/unban");
      const isList = lowerMsg.startsWith("/list") || lowerMsg.startsWith("/users");
      const isKickAll = lowerMsg.startsWith("/kickall");

      if (isList) {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const list = [];
        for (const [, s] of this.sessions.entries()) {
          if (s.username) {
            let entry = s.username;
            if (s.displayName && s.displayName !== s.username)
              entry += " [" + s.displayName + "]";
            if (s.userId) entry += " #" + s.userId;
            list.push(entry);
          }
        }
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message:
                list.length > 0
                  ? "المتصلون (" + list.length + "): " + list.join(" | ")
                  : "مافيش حد متصل حاليًا.",
            })
          );
        } catch (e) {}
        return;
      }

      if (isKickAll) {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
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
                anim: "kick",
              })
            );
            count++;
          } catch (e) {}
        }
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message: "تم إرسال أمر الطرد لـ " + count + " لاعب.",
            })
          );
        } catch (e) {}
        return;
      }

      if (isKick || isBan || isUnban) {
        const myName = session.username ? session.username.toLowerCase() : "";
        const canKick = session.isOwner || this.admins.has(myName);
        const canBan = session.isOwner;

        if (isBan || isUnban) {
          if (!canBan) {
            try {
              webSocket.send(JSON.stringify({ error: "not_allowed" }));
            } catch (e) {}
            return;
          }
        } else if (!canKick) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }

        const cmdLen = isKick ? 5 : isBan ? 4 : 6;
        const rest = rawMessage.slice(cmdLen).trim();
        const parts = rest.split(/\s+/).filter(Boolean);
        const targetName = parts[0];
        const reasonText = parts.slice(1).join(" ");

        if (!targetName) {
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message:
                  "الصيغة: /kick أو /ban أو /unban <الاسم> <السبب اختياري>\n/list لعرض المتصلين",
              })
            );
          } catch (e) {}
          return;
        }

        const targetLower = targetName.toLowerCase();

        if (isUnban) {
          this.bannedUsers.delete(targetLower);
          await this.saveBanned();
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message: "تم فك الحظر عن " + targetName,
              })
            );
          } catch (e) {}
          return;
        }

        if (isKick) {
          const anim = session.isOwner ? "kick" : "none";
          const res = this.kickTarget(webSocket, session, targetName, reasonText, anim);
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message:
                  res.kicked > 0
                    ? "تم طرد: " +
                      res.matches
                        .filter((m) => m.session.username)
                        .map((m) => m.session.username)
                        .join(", ") +
                      (reasonText ? " — السبب: " + reasonText : "")
                    : "اللاعب " + targetName + " غير متصل أو محمي.",
              })
            );
          } catch (e) {}
          return;
        }

        const matches = this.findSessionsByTarget(targetName);
        const isOwnerTarget =
          targetLower === this.getOwnerUsername().toLowerCase() ||
          matches.some((m) => m.session.isOwner);

        if (!isOwnerTarget) {
          this.bannedUsers.add(targetLower);
          await this.saveBanned();
        }

        for (const m of matches) {
          try {
            m.ws.send(
              JSON.stringify({
                error: "kicked",
                target: m.session.username,
                reason: reasonText || KICK_MESSAGE,
                anim: "ban",
              })
            );
          } catch (e) {}
          try {
            m.ws.close();
          } catch (e) {}
        }

        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message: isOwnerTarget
                ? "وضع تجريبي: تم تشغيل أنميشن الحظر بدون حظر فعلي."
                : "تم حظر: " +
                    (matches.length > 0
                      ? matches.map((m) => m.session.username).join(", ")
                      : targetName) +
                    (reasonText ? " — السبب: " + reasonText : ""),
            })
          );
        } catch (e) {}
        return;
      }

      if (lowerMsg.startsWith("/help")) {
        const myName = session.username ? session.username.toLowerCase() : "";
        let msg;
        if (session.isOwner) {
          msg =
            "أوامر المالك: /kick /ban /unban /kickall /list | ⋮ بجانب الرسالة: طرد/حظر/كتم عام/مشرفون/انضمام | /copy نسخ | /clear مسح";
        } else if (this.admins.has(myName)) {
          msg =
            "أوامر المشرف: /kick <الاسم> | ⋮ بجانب الرسالة: طرد | /w همس | /copy نسخ | /clear مسح";
        } else {
          msg =
            "أوامرك: /w اسم رسالة (همس) | ضغطة على الرسالة = همس | ⋮: كتم محلي/إبلاغ/نسخ | /clear مسح | /copy عدد نسخ";
        }
        try {
          webSocket.send(JSON.stringify({ type: "system", message: msg }));
        } catch (e) {}
        return;
      }

      if (this.containsLink(rawMessage)) {
        try {
          webSocket.send(JSON.stringify({ error: "links_not_allowed" }));
        } catch (e) {}
        return;
      }

      if (!this.checkRateLimit(session)) {
        try {
          webSocket.send(JSON.stringify({ error: "rate_limited" }));
        } catch (e) {}
        return;
      }

      const msg = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
        username: session.username,
        message: rawMessage,
        created_at: Date.now(),
      };

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
