import { DurableObject } from "cloudflare:workers";

const OWNER_USERNAME = "maalek_1234";

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

        if (this.bannedUsers.has(data.username)) {
          try {
            webSocket.send(JSON.stringify({ error: "banned" }));
          } catch (e) {}
          webSocket.close();
          return;
        }
      }

      if (data.type === "kick") {
        if (data.requester !== OWNER_USERNAME) return;
        const target = data.target;
        if (!target) return;

        this.bannedUsers.add(target);
        await this.saveBanned();

        for (const [ws, uname] of this.socketUsernames.entries()) {
          if (uname === target) {
            try {
              ws.send(JSON.stringify({ error: "kicked", reason: data.reason || "" }));
              ws.close();
            } catch (e) {}
          }
        }

        this.broadcast(
          JSON.stringify({
            type: "system",
            message: target + " تم طرده" + (data.reason ? ": " + data.reason : ""),
          }),
          null
        );
        return;
      }

      if (data.type === "unban") {
        if (data.requester !== OWNER_USERNAME) return;
        this.bannedUsers.delete(data.target);
        await this.saveBanned();
        return;
      }

      if (data.type === "typing") {
        const payload = JSON.stringify({
          type: "typing",
          username: data.username || "",
          typing: !!data.typing,
        });
        this.broadcast(payload, webSocket);
        return;
      }

      if (data.type === "seen") {
        const payload = JSON.stringify({
          type: "seen",
          messageId: data.messageId || "",
          username: data.username || "",
        });
        this.broadcast(payload, webSocket);
        return;
      }

      if (this.containsLink(data.message)) {
        try {
          webSocket.send(JSON.stringify({ error: "links_not_allowed" }));
        } catch (e) {}
        return;
      }

      const { success } = await this.env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        try {
          webSocket.send(JSON.stringify({ error: "rate_limited" }));
        } catch (e) {}
        return;
      }

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
