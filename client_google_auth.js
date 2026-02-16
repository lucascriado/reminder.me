require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3000);

const REQUIRED_ENVS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error(`❌ Faltou ${k} no .env`);
    process.exit(1);
  }
}

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// Cliente OAuth
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Se já tiver refresh_token no .env, já configura aqui
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

const SCOPES = ["openid", "email", "profile"];

// Arquivo onde vamos salvar o refresh token quando vier
const ENV_LOCAL_PATH = path.join(process.cwd(), ".env.local");

function upsertEnvLocal(key, value) {
  let content = "";
  if (fs.existsSync(ENV_LOCAL_PATH)) content = fs.readFileSync(ENV_LOCAL_PATH, "utf8");

  const line = `${key}=${value}\n`;
  const regex = new RegExp(`^${key}=.*$`, "m");

  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += line;
  }

  fs.writeFileSync(ENV_LOCAL_PATH, content, "utf8");
}

// Helpers pra “sessão” simples via cookie (pra testar /me)
function setSessionCookie(res, payloadObj) {
  const json = JSON.stringify(payloadObj);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  res.cookie("session", b64, { httpOnly: true, sameSite: "lax", secure: false, maxAge: 60 * 60 * 1000 });
}
function getSession(req) {
  const b64 = req.cookies.session;
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Home
app.get("/", (req, res) => {
  const session = getSession(req);

  res.type("html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Login Google</title>
    <style>
      body { font-family: Arial; max-width: 820px; margin: 40px auto; }
      button { padding: 12px 16px; font-size: 16px; cursor: pointer; }
      .box { padding: 16px; border: 1px solid #ddd; border-radius: 10px; margin-bottom: 16px; }
      code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
      a { margin-right: 12px; }
      .small { color: #666; font-size: 13px; }
    </style>
  </head>
  <body>
    <h1>Autenticação com Google</h1>

    <div class="box">
      <p class="small">Redirect configurado: <code>${REDIRECT_URI}</code></p>
      <a href="/auth/google"><button>Entrar com Google</button></a>
      <a href="/me">/me</a>
      <a href="/tokens">/tokens</a>
      <a href="/logout">logout</a>
    </div>

    <div class="box">
      <h3>Status</h3>
      ${
        session
          ? `<p>Logado como: <b>${session.email}</b> (${session.name || "sem nome"})</p>`
          : `<p>Não logado ainda.</p>`
      }
      <p class="small">Veja o console do Node para logs do callback.</p>
      <p class="small">Se o refresh token vier, ele será salvo em <code>.env.local</code>.</p>
    </div>
  </body>
</html>
  `);
});

// Inicia OAuth
app.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 10 * 60 * 1000,
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    redirect_uri: REDIRECT_URI,
  });

  return res.redirect(authUrl);
});

// Callback
app.get("/oauth2/callback", async (req, res) => {
  console.log("CALLBACK QUERY:", req.query);

  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const savedState = req.cookies.oauth_state;

    if (!code) return res.status(400).send("Sem code no callback.");
    if (!state || !savedState || state !== savedState) {
      return res.status(400).send("State inválido (cookie não bate).");
    }

    const { tokens } = await oauth2Client.getToken({ code, redirect_uri: REDIRECT_URI });
    oauth2Client.setCredentials(tokens);

    // Busca dados do usuário
    const oauth2 = google.oauth2({ auth: oauth2Client, version: "v2" });
    const me = await oauth2.userinfo.get();

    const user = {
      id: me.data.id || null,
      email: me.data.email || null,
      name: me.data.name || null,
      picture: me.data.picture || null,
    };

    // ✅ LOG DO USUÁRIO (o que você pediu)
    console.log("USER AUTH:", user);

    // ✅ LOG DOS TOKENS (sem vazar token inteiro no console)
    console.log("TOKENS:", {
      has_access_token: !!tokens.access_token,
      has_refresh_token: !!tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
      token_type: tokens.token_type,
    });

    // ✅ Se veio refresh_token, salva em .env.local
    if (tokens.refresh_token) {
      upsertEnvLocal("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
      console.log(`✅ GOOGLE_REFRESH_TOKEN salvo em ${ENV_LOCAL_PATH}`);
    }

    // cookie de sessão só pra teste
    setSessionCookie(res, user);

    // Limpa state cookie
    res.clearCookie("oauth_state");

    // resposta simples (pode ser só console log, mas deixei uma página pra debug)
    res.type("html").send(`
      <h2>Login ok ✅</h2>
      <p><b>Nome:</b> ${user.name || ""}</p>
      <p><b>Email:</b> ${user.email || ""}</p>
      <p><b>ID:</b> ${user.id || ""}</p>
      <hr/>
      <p><b>refresh_token:</b> ${
        tokens.refresh_token ? "recebido e salvo em .env.local ✅" : "não veio (normal se já autorizou antes)"
      }</p>
      <p><a href="/">Voltar</a> | <a href="/me">/me</a> | <a href="/logout">logout</a></p>
    `);
  } catch (err) {
    console.error("ERRO CALLBACK:", err);
    res.status(500).send("Erro no callback. Veja o console.");
  }
});

// Mostra usuário logado (teste)
app.get("/me", (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false, error: "not_logged_in" });
  return res.json({ ok: true, user: session });
});

// Mostra se há refresh token no env atual (teste)
app.get("/tokens", (req, res) => {
  return res.json({
    ok: true,
    has_refresh_token_in_env: !!process.env.GOOGLE_REFRESH_TOKEN,
    note: "Se não tiver no .env, pode ter sido salvo em .env.local",
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("oauth_state");
  res.clearCookie("session");
  res.redirect("/");
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Callback esperado: ${REDIRECT_URI}`);
  console.log(`Dica: se vier refresh_token, salvo em ${ENV_LOCAL_PATH}`);
});
