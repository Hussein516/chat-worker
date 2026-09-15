import { DurableObject } from "cloudflare:workers";

const KICK_MESSAGE = "لقد قمت بطرد نفسي بنفسي.";
const HISTORY_LIMIT = 30;
const RATE_LIMIT_PER_USER = 15;
const RATE_LIMIT_WINDOW_MS = 10000;
const PING_INTERVAL_MS = 25000;
const MAX_USERNAME_LEN = 32;
const MAX_MESSAGE_LEN = 300;
const AUTH_TIMEOUT_MS = 3000;

const SCRIPT_SOURCES = [
  "https://gist.githubusercontent.com/Hussein516/639729fccb66180848cf5364ce71870f/raw/626e5f6c464b0ea79530d983cb5fd70ab8c056b1/chat.lua",
  "https://cdn.jsdelivr.net/gh/Hussein516/Script@main/Idk",
  "https://raw.githubusercontent.com/Hussein516/Script/main/Idk",
];

const EMBEDDED_SCRIPT_FALLBACK =
  "-- [Chat] تعذر تحميل السكربت من كل المصادر\n" +
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
    } catch (e) {
      // جرب المصدر التالي
    }
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
    this.pingTimer = null;
    this.ready = this.loadState();
  }

  async loadState() {
    try {
      const stored = await this.ctx.storage.get("banned");
      if (Array.isArray(stored)) {
        this.bannedUsers = new Set(stored.map((u) => String(u).toLowerCase()));
      }
    } catch (e) {
      this.bannedUsers = new Set();
    }
  }

  async saveBanned() {
    try {
      await this.ctx.storage.put("banned", Array.from(this.bannedUsers));
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
      this.sessions.delete(ws);
      try {
        ws.close();
      } catch (e) {}
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

    const path = new URL(request.url).pathname;

    // ✅ نقطة نهاية جديدة: تصفير قائمة المحظورين
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
    };
    this.sessions.set(webSocket, session);
    this.startPing();

    try {
      webSocket.send(JSON.stringify({ type: "history", messages: this.messages }));
    } catch (e) {}

    webSocket.addEventListener("message", async (event) => {
      await this.ready;

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
      }

      if (data.type === "typing") {
        if (!session.username) return;
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

      if (data.type === "unban") {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;
        this.bannedUsers.delete(target);
        await this.saveBanned();
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message: "تم فك الحظر عن " + target,
            })
          );
        } catch (e) {}
        return;
      }

      if (data.type === "ban") {
        if (!session.isOwner) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;
        this.bannedUsers.add(target);
        await this.saveBanned();
        try {
          webSocket.send(
            JSON.stringify({ type: "system", message: "تم حظر " + target })
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
        if (!session.isOwner) {
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

        if (isBan) {
          this.bannedUsers.add(targetLower);
          await this.saveBanned();
        }

        const finalReason = reasonText || KICK_MESSAGE;
        const matches = this.findSessionsByTarget(targetName);

        if (matches.length === 0) {
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message:
                  "اللاعب " +
                  targetName +
                  " غير متصل حاليًا. استخدم /list لعرض المتصلين.",
              })
            );
          } catch (e) {}
          return;
        }

        for (const m of matches) {
          try {
            m.ws.send(
              JSON.stringify({
                error: "kicked",
                target: m.session.username,
                reason: finalReason,
              })
            );
          } catch (e) {}
          if (isBan) {
            try {
              m.ws.close();
            } catch (e) {}
          }
        }

        const names = matches.map((m) => m.session.username).join(", ");
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message:
                (isBan ? "تم حظر: " : "تم طرد: ") +
                names +
                (reasonText ? " — السبب: " + reasonText : ""),
            })
          );
        } catch (e) {}
        return;
      }

      if (lowerMsg.startsWith("/help")) {
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message: session.isOwner
                ? "الأوامر: /kick /ban /unban /kickall /list"
                : "ما عندكش صلاحيات إدارية.",
            })
          );
        } catch (e) {}
        return;
      }

      if (!session.username) {
        try {
          webSocket.send(JSON.stringify({ error: "no_username" }));
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
      this.sessions.delete(webSocket);
    });

    webSocket.addEventListener("error", () => {
      this.sessions.delete(webSocket);
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
