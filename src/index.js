import { DurableObject } from "cloudflare:workers";

const OWNER_USERNAME = "maalek_1234";
const KICK_MESSAGE = "لقد قمت بطرد نفسي بنفسي.";

export class ChatRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.sessions = [];
    this.messages = [];
    this.socketUsernames = new Map();
    this.bannedUsers = new Set();
    this.ready = this.loadState();
  }

  async loadState() {
    const stored = await this.ctx.storage.get("banned");
    if (Array.isArray(stored)) {
      this.bannedUsers = new Set(stored);
    }
  }

  async saveBanned() {
    await this.ctx.storage.put("banned", Array.from(this.bannedUsers));
  }

  containsLink(text) {
    return /https?:\/\/|www\.|discord\.gg|\.com\b|\.net\b|\.io\b|\.gg\b|\.xyz\b|\.bet\b|\.casino\b/i.test(text || "");
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      this.handleSession(server, ip);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Chat room is active", { status: 200 });
  }

  broadcast(payload, excludeWs) {
    this.sessions = this.sessions.filter((ws) => {
      if (ws === excludeWs) return true;
      try {
        ws.send(payload);
        return true;
      } catch (err) {
        return false;
      }
    });
  }

  handleSession(webSocket, ip) {
    webSocket.accept();
    this.sessions.push(webSocket);

    webSocket.addEventListener("message", async (event) => {
      await this.ready;

      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (data.username) {
        this.socketUsernames.set(webSocket, data.username);

        if (this.bannedUsers.has(data.username.toLowerCase())) {
          try {
            webSocket.send(JSON.stringify({ error: "banned" }));
          } catch (e) {}
          webSocket.close();
          return;
        }
      }

      // ============ UNBAN (اختياري) ============
      if (data.type === "unban") {
        if (data.requester !== OWNER_USERNAME) return;
        this.bannedUsers.delete((data.target || "").toLowerCase());
        await this.saveBanned();
        return;
      }

      // ============ TYPING ============
      if (data.type === "typing") {
        this.broadcast(
          JSON.stringify({
            type: "typing",
            username: data.username || "",
            typing: !!data.typing,
          }),
          webSocket
        );
        return;
      }

      // ============ SEEN ============
      if (data.type === "seen") {
        this.broadcast(
          JSON.stringify({
            type: "seen",
            messageId: data.messageId || "",
            username: data.username || "",
          }),
          webSocket
        );
        return;
      }

      // ==============================================================
      // ============ أمر الطرد /kick <اسم> <سبب اختياري> =============
      // ==============================================================
      const rawMessage = String(data.message || "");
      if (rawMessage.toLowerCase().startsWith("/kick")) {
        // 1) لازم يكون المرسل هو الأونر
        if (data.username !== OWNER_USERNAME) {
          try {
            webSocket.send(JSON.stringify({ error: "not_allowed" }));
          } catch (e) {}
          return;
        }

        // 2) استخراج الاسم + السبب
        const rest = rawMessage.slice(5).trim(); // بعد /kick
        const parts = rest.split(/\s+/).filter(Boolean);
        const targetName = parts[0];
        const reasonText = parts.slice(1).join(" "); // كل الكلام بعد الاسم

        if (!targetName) {
          try {
            webSocket.send(
              JSON.stringify({
                type: "system",
                message: "استخدم الصيغة: /kick <اسم اللاعب> <السبب اختياري>",
              })
            );
          } catch (e) {}
          return;
        }

        const targetLower = targetName.toLowerCase();
        const finalReason = reasonText || KICK_MESSAGE;
        let found = false;

        // 3) ابحث عن الهدف وابعتله إشارة الطرد فقط
        for (const [ws, uname] of this.socketUsernames.entries()) {
          if (uname.toLowerCase() === targetLower) {
            found = true;
            try {
              ws.send(
                JSON.stringify({
                  error: "kicked",
                  target: uname,
                  reason: finalReason,
                })
              );
            } catch (e) {}
          }
        }

        // 4) إشعار للأونر
        try {
          webSocket.send(
            JSON.stringify({
              type: "system",
              message: found
                ? "تم إرسال أمر الطرد إلى " + targetName + (reasonText ? " — السبب: " + reasonText : "")
                : "اللاعب " + targetName + " غير متصل حاليًا",
            })
          );
        } catch (e) {}

        // 5) مهم: ما نبعتهاش كرسالة شات
        return;
      }
      // ==============================================================

      // ============ منع الروابط ============
      if (this.containsLink(data.message)) {
        try {
          webSocket.send(JSON.stringify({ error: "links_not_allowed" }));
        } catch (e) {}
        return;
      }

      // ============ Rate limit ============
      const { success } = await this.env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        try {
          webSocket.send(JSON.stringify({ error: "rate_limited" }));
        } catch (e) {}
        return;
      }

      // ============ رسالة عادية ============
      const msg = {
        id: Date.now().toString() + Math.random().toString(16).slice(2),
        username: data.username || "",
        message: data.message || "",
        created_at: Date.now(),
      };

      this.messages.push(msg);
      if (this.messages.length > 20) this.messages.shift();

      this.broadcast(JSON.stringify(msg), null);
    });

    webSocket.addEventListener("close", () => {
      this.sessions = this.sessions.filter((ws) => ws !== webSocket);
      this.socketUsernames.delete(webSocket);
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
