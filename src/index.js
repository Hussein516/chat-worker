import { DurableObject } from "cloudflare:workers";

const KICK_MESSAGE = "لقد قمت بطرد نفسي بنفسي.";
const HISTORY_LIMIT = 30;
const RATE_LIMIT_PER_USER = 15;
const RATE_LIMIT_WINDOW_MS = 10000;
const PING_INTERVAL_MS = 25000;
const MAX_USERNAME_LEN = 32;
const MAX_MESSAGE_LEN = 300;
const AUTH_TIMEOUT_MS = 3000; // مهلة التحقق كمالك

export class ChatRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.env = env;
    this.sessions = new Map(); // ws -> session
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
    return /(?:https?:\/\/|www\.)\S+|\bdiscord\.gg\/\S+|\b(?:t\.me|telegram\.me)\/\S+/i.test(text);
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
      try { ws.close(); } catch (e) {}
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

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      this.handleSession(server, ip);
      return new Response(null, { status: 101, webSocket: client });
    }

    // نقطة فحص HTTP
    return new Response(
      JSON.stringify({
        status: "active",
        online: this.sessions.size,
        cachedMessages: this.messages.length,
        banned: this.bannedUsers.size,
        time: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  handleSession(webSocket, ip) {
    webSocket.accept();

    const session = {
      username: null,
      ip,
      isOwner: false,
      rateCount: 0,
      rateReset: Date.now(),
      authDeadline: Date.now() + AUTH_TIMEOUT_MS, // لو ما بعتش auth خلال المهلة، ما يبقى owner
    };
    this.sessions.set(webSocket, session);
    this.startPing();

    // إرسال التاريخ فوراً
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

      // ---------- AUTH ----------
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

      // ---------- تسجيل اسم المستخدم ----------
      if (typeof data.username === "string" && data.username.length > 0) {
        const uname = data.username.slice(0, MAX_USERNAME_LEN);
        const lower = uname.toLowerCase();

        if (this.bannedUsers.has(lower) && !session.isOwner) {
          try { webSocket.send(JSON.stringify({ error: "banned" })); } catch (e) {}
          try { webSocket.close(); } catch (e) {}
          return;
        }

        // ممنوع أي حد يستخدم اسم المالك إلا لو عنده توكن صحيح
        if (uname === this.getOwnerUsername() && !session.isOwner) {
          try {
            webSocket.send(JSON.stringify({
              type: "system",
              message: "اسم المالك محجوز. اختر اسمًا آخر.",
            }));
          } catch (e) {}
          return;
        }

        session.username = uname;
      }

      // ---------- TYPING ----------
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

      // ---------- SEEN ----------
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

      // ---------- PONG ----------
      if (data.type === "pong") return;

      // ---------- HELLO ----------
      if (data.type === "hello") {
        // مجرد إشعار، ما نعملش حاجة
        return;
      }

      // ---------- UNBAN ----------
      if (data.type === "unban") {
        if (!session.isOwner) {
          try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {}
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;
        this.bannedUsers.delete(target);
        await this.saveBanned();
        try {
          webSocket.send(JSON.stringify({ type: "system", message: "تم فك الحظر عن " + target }));
        } catch (e) {}
        return;
      }

      // ---------- BAN ----------
      if (data.type === "ban") {
        if (!session.isOwner) {
          try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {}
          return;
        }
        const target = String(data.target || "").toLowerCase().trim();
        if (!target) return;
        this.bannedUsers.add(target);
        await this.saveBanned();
        try {
          webSocket.send(JSON.stringify({ type: "system", message: "تم حظر " + target }));
        } catch (e) {}
        return;
      }

      // ---------- أوامر الشات ----------
      const rawMessage = String(data.message || "").slice(0, MAX_MESSAGE_LEN);
      const lowerMsg = rawMessage.toLowerCase();

      const isKick = lowerMsg.startsWith("/kick");
      const isBan = lowerMsg.startsWith("/ban");
      const isUnban = lowerMsg.startsWith("/unban");

      if (isKick || isBan || isUnban) {
        if (!session.isOwner) {
          try { webSocket.send(JSON.stringify({ error: "not_allowed" })); } catch (e) {}
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
                message: "الصيغة: /kick أو /ban أو /unban <الاسم> <السبب اختياري>",
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
              JSON.stringify({ type: "system", message: "تم فك الحظر عن " + targetName })
            );
          } catch (e) {}
          return;
        }

        if (isBan) {
          this.bannedUsers.add(targetLower);
          await this.saveBanned();
        }

        const finalReason = reasonText || KICK_MESSAGE;
        let found = false;

        for (const [ws, s] of this.sessions.entries()) {
          if (s.username && s.username.toLowerCase() === targetLower) {
            found = true;
            try {
              ws.send(
                JSON.stringify({
                  error: "kicked",
                  target: s.username,
                  reason: finalReason,
                })
              );
            } catch (e) {}
            if (isBan) {
              try { ws.close(); } catch (e) {}
            }
          }
        }

        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message: found
                ? (isBan ? "تم حظر " : "تم طرد ") +
                  targetName +
                  (reasonText ? " — السبب: " + reasonText : "")
                : "اللاعب " + targetName + " غير متصل حاليًا",
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
                ? "الأوامر: /kick /ban /unban"
                : "ما عندكش صلاحيات إدارية.",
            })
          );
        } catch (e) {}
        return;
      }

      // ---------- رسالة عادية ----------
      if (!session.username) {
        try { webSocket.send(JSON.stringify({ error: "no_username" })); } catch (e) {}
        return;
      }

      if (this.containsLink(rawMessage)) {
        try { webSocket.send(JSON.stringify({ error: "links_not_allowed" })); } catch (e) {}
        return;
      }

      if (!this.checkRateLimit(session)) {
        try { webSocket.send(JSON.stringify({ error: "rate_limited" })); } catch (e) {}
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
    const id = env.CHAT_ROOM.idFromName("global-room");
    const stub = env.CHAT_ROOM.get(id);
    return stub.fetch(request);
  },
};
