import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const app = express();
const port = Number(process.env.PORT || 3000);

const CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const RAW_BOT_API_URL = String(process.env.BOT_API_URL || "").trim();
const BOT_API_URL = RAW_BOT_API_URL
  ? (/^https?:\/\//i.test(RAW_BOT_API_URL)
      ? RAW_BOT_API_URL
      : `https://${RAW_BOT_API_URL}`)
      .replace(/\/+$/, "")
  : "";
const DICE_BRIDGE_SECRET = process.env.DICE_BRIDGE_SECRET || "";
const DICE_ADMIN_PASSWORD = process.env.DICE_ADMIN_PASSWORD || "";
const ADMIN_SESSION_MS = 30 * 60 * 1000;
const adminSessions = new Map();
const adminFailures = new Map();

if (!CLIENT_ID) console.warn("Missing VITE_DISCORD_CLIENT_ID");
if (!CLIENT_SECRET) console.warn("Missing DISCORD_CLIENT_SECRET");
if (!BOT_API_URL) console.warn("Missing BOT_API_URL");
if (!DICE_BRIDGE_SECRET) console.warn("Missing DICE_BRIDGE_SECRET");
if (!DICE_ADMIN_PASSWORD) console.warn("Missing DICE_ADMIN_PASSWORD (Admin Test Mode disabled)");

app.use(express.json({ limit: "32kb" }));

function safeEqualText(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function pruneAdminSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of adminSessions) {
    if (expiresAt <= now) adminSessions.delete(token);
  }
}

function adminTokenFromReq(req) {
  const auth = String(req.headers.authorization || "");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function adminSessionValid(req) {
  pruneAdminSessions();
  const token = adminTokenFromReq(req);
  const expiresAt = adminSessions.get(token) || 0;
  return Boolean(token && expiresAt > Date.now());
}

async function discordUserFromBearer(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return null;

  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: auth },
  });

  if (!response.ok) return null;
  return response.json();
}

async function callBot(pathname, body) {
  if (!BOT_API_URL) {
    return {
      response: null,
      json: { ok: false, error: "BOT_API_URL_MISSING" },
      status: 500,
    };
  }

  let target;

  try {
    target = new URL(`${BOT_API_URL}${pathname}`);
  } catch (err) {
    console.error("Invalid BOT_API_URL:", BOT_API_URL, err);
    return {
      response: null,
      json: { ok: false, error: "BOT_API_URL_INVALID" },
      status: 500,
    };
  }

  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dice-bridge-secret": DICE_BRIDGE_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    const text = await response.text();

    let json;

    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      console.error(
        "Bot bridge returned non-JSON:",
        response.status,
        text.slice(0, 500)
      );

      json = {
        ok: false,
        error: `BOT_NON_JSON_${response.status}`,
      };
    }

    console.log(
      `[Dice Bridge] ${pathname} -> ${response.status}`,
      json?.error || "OK"
    );

    return {
      response,
      json,
      status: response.status,
    };
  } catch (err) {
    const cause =
      err?.cause?.code ||
      err?.code ||
      err?.name ||
      "UNKNOWN";

    console.error(
      `[Dice Bridge] Could not reach bot at ${BOT_API_URL}${pathname}:`,
      err
    );

    return {
      response: null,
      json: {
        ok: false,
        error:
          cause === "TimeoutError" || cause === "AbortError"
            ? "BOT_TIMEOUT"
            : "BOT_UNREACHABLE",
        detail: String(cause),
      },
      status: 502,
    };
  }
}

app.post("/api/admin/login", (req, res) => {
  if (!DICE_ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, error: "ADMIN_NOT_CONFIGURED" });
  }

  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const state = adminFailures.get(ip) || { count: 0, lockedUntil: 0 };
  if (state.lockedUntil > Date.now()) {
    return res.status(429).json({ ok: false, error: "ADMIN_LOCKED" });
  }

  const password = String(req.body?.password || "");
  if (!safeEqualText(password, DICE_ADMIN_PASSWORD)) {
    state.count += 1;
    if (state.count >= 5) {
      state.lockedUntil = Date.now() + 60_000;
      state.count = 0;
    }
    adminFailures.set(ip, state);
    return res.status(401).json({ ok: false, error: "BAD_ADMIN_PASSWORD" });
  }

  adminFailures.delete(ip);
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  adminSessions.set(token, expiresAt);
  return res.json({ ok: true, token, expiresAt });
});

app.get("/api/admin/session", (req, res) => {
  const valid = adminSessionValid(req);
  const token = adminTokenFromReq(req);
  return res.json({
    ok: true,
    configured: Boolean(DICE_ADMIN_PASSWORD),
    authenticated: valid,
    expiresAt: valid ? adminSessions.get(token) : null,
  });
});

app.post("/api/admin/logout", (req, res) => {
  const token = adminTokenFromReq(req);
  if (token) adminSessions.delete(token);
  return res.json({ ok: true });
});

app.get("/api/health", async (_req, res) => {
  let botHealth = {
    reachable: false,
    status: null,
    error: null,
  };

  if (BOT_API_URL) {
    try {
      const response = await fetch(`${BOT_API_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      botHealth.status = response.status;
      botHealth.reachable = response.ok;

      if (!response.ok) {
        botHealth.error = `HTTP_${response.status}`;
      }
    } catch (err) {
      botHealth.error =
        err?.cause?.code ||
        err?.code ||
        err?.name ||
        "BOT_UNREACHABLE";
    }
  } else {
    botHealth.error = "BOT_API_URL_MISSING";
  }

  res.json({
    ok: true,
    service: "mixer-dice-activity",
    clientIdConfigured: Boolean(CLIENT_ID),
    clientSecretConfigured: Boolean(CLIENT_SECRET),
    botApiConfigured: Boolean(BOT_API_URL),
    botApiHost: BOT_API_URL
      ? (() => {
          try {
            return new URL(BOT_API_URL).host;
          } catch {
            return "INVALID";
          }
        })()
      : null,
    bridgeSecretConfigured: Boolean(DICE_BRIDGE_SECRET),
    adminModeConfigured: Boolean(DICE_ADMIN_PASSWORD),
    botHealth,
  });
});

app.post("/api/token", async (req, res) => {
  const code = String(req.body?.code || "");
  if (!code) return res.status(400).json({ error: "MISSING_CODE" });

  try {
    const response = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });

    const json = await response.json();

    if (!response.ok || !json.access_token) {
      console.error("Discord token exchange failed:", json);
      return res.status(response.status || 500).json({
        error: "TOKEN_EXCHANGE_FAILED",
      });
    }

    return res.json({ access_token: json.access_token });
  } catch (err) {
    console.error("Token exchange error:", err);
    return res.status(500).json({ error: "TOKEN_EXCHANGE_ERROR" });
  }
});

app.post("/api/pending-roll", async (req, res) => {
  try {
    const user = await discordUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "BAD_USER_TOKEN" });

    const guildId = String(req.body?.guildId || "");
    const channelId = String(req.body?.channelId || "");

    if (!guildId || !channelId) {
      return res.status(400).json({ ok: false, error: "MISSING_CONTEXT" });
    }

    const { response, json, status } = await callBot("/dice/pending", {
      guildId,
      channelId,
      userId: user.id,
    });

    return res.status(status || response?.status || 500).json(json);
  } catch (err) {
    console.error("Pending-roll proxy error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

app.post("/api/roll-result", async (req, res) => {
  try {
    const user = await discordUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "BAD_USER_TOKEN" });

    const guildId = String(req.body?.guildId || "");
    const channelId = String(req.body?.channelId || "");
    const campaignChannelId = String(req.body?.campaignChannelId || "");
    const pendingId = String(req.body?.pendingId || "");
    const die = String(req.body?.die || "");
    const result = Number(req.body?.result);
    const rolls = Array.isArray(req.body?.rolls)
      ? req.body.rolls.map(Number)
      : [];

    if (!guildId || !pendingId) {
      return res.status(400).json({ ok: false, error: "MISSING_CONTEXT" });
    }

    const { response, json, status } = await callBot("/dice/result", {
      guildId,
      channelId,
      campaignChannelId,
      pendingId,
      userId: user.id,
      die,
      result,
      rolls,
    });

    return res.status(status || response?.status || 500).json(json);
  } catch (err) {
    console.error("Roll-result proxy error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dist = path.join(__dirname, "dist");

app.use(express.static(dist));

app.get("*splat", (_req, res) => {
  res.sendFile(path.join(dist, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Mixer Dice Activity server listening on ${port}`);
});
