import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.sessions = [];
    this.messages = [];
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      this.handleSession(server, ip);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Chat room is active", { status: 200 });
  }

  handleSession(webSocket, ip) {
    webSocket.accept();
    this.sessions.push(webSocket);

    webSocket.addEventListener("message", async (event) => {
      // ====== فحص Rate Limit: 20 رسالة كل 10 ثواني لكل IP ======
      const { success } = await this.env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        try {
          webSocket.send(JSON.stringify({ error: "rate_limited" }));
        } catch (e) {}
        return;
      }

      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
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

      const payload = JSON.stringify(msg);
      this.sessions = this.sessions.filter((ws) => {
        try {
          ws.send(payload);
          return true;
        } catch (err) {
          return false;
        }
      });
    });

    webSocket.addEventListener("close", () => {
      this.sessions = this.sessions.filter((ws) => ws !== webSocket);
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
