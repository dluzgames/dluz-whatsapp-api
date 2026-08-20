const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_info_baileys");

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let qrCodeData = null;
let connectionState = "DISCONNECTED";
let connectedNumber = null;

const logger = pino({ level: "silent" });

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: state,
    browser: ["DLuz Games", "Chrome", "120.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = "SCAN_QR";
      try {
        qrCodeData = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error("Erro ao gerar QR Code:", err);
      }
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        "Conexão fechada. Motivo:",
        lastDisconnect?.error,
        ", Reconectar:",
        shouldReconnect
      );
      connectionState = "DISCONNECTED";
      connectedNumber = null;
      qrCodeData = null;
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    } else if (connection === "open") {
      connectionState = "CONNECTED";
      qrCodeData = null;
      connectedNumber = sock.user?.id ? sock.user.id.split(":")[0] : "WhatsApp Conectado";
      console.log("✓ WhatsApp conectado com sucesso! Número:", connectedNumber);
    }
  });
}

// 1. Rota Principal & Visualização do QR Code
app.get(["/", "/qr"], (req, res) => {
  let content = "";
  if (connectionState === "CONNECTED") {
    content = `
      <div style="background: #111b21; padding: 30px; border-radius: 16px; text-align: center; border: 1px solid #00a884; max-width: 420px; width: 90%;">
        <div style="font-size: 54px; margin-bottom: 12px;">🟢</div>
        <h2 style="color: #00a884; margin: 0 0 10px 0;">WhatsApp Conectado!</h2>
        <p style="color: #e9edef; font-size: 16px; margin: 0 0 16px 0;">Número Ativo: <strong>+${connectedNumber}</strong></p>
        <p style="color: #8696a0; font-size: 13px; margin: 0;">Pronto para receber pedidos e disparar mensagens automáticas via API e n8n.</p>
      </div>
    `;
  } else if (qrCodeData) {
    content = `
      <div style="background: #111b21; padding: 26px; border-radius: 16px; text-align: center; border: 1px solid #2a3942; max-width: 420px; width: 90%;">
        <h2 style="color: #e9edef; margin: 0 0 8px 0;">Conectar WhatsApp</h2>
        <p style="color: #8696a0; font-size: 13px; margin: 0 0 16px 0;">Abra o WhatsApp no celular > <strong>Aparelhos Conectados</strong> > <strong>Conectar um aparelho</strong> e aponte para o QR Code abaixo:</p>
        <img src="${qrCodeData}" style="width: 260px; height: 260px; border-radius: 12px; background: white; padding: 10px;" />
        <p style="color: #00a884; font-size: 12px; margin-top: 14px;">⚡ A página atualiza automaticamente a cada 4 segundos...</p>
      </div>
    `;
  } else {
    content = `
      <div style="background: #111b21; padding: 30px; border-radius: 16px; text-align: center; border: 1px solid #2a3942; max-width: 420px; width: 90%;">
        <div style="font-size: 40px; margin-bottom: 10px;">⏳</div>
        <h3 style="color: #e9edef; margin: 0 0 8px 0;">Gerando QR Code...</h3>
        <p style="color: #8696a0; font-size: 13px; margin: 0;">Aguarde alguns segundos enquanto o serviço inicializa o Baileys.</p>
      </div>
    `;
  }

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>DLuz WhatsApp API</title>
      <meta http-equiv="refresh" content="${connectionState === "CONNECTED" ? "15" : "4"}">
      <style>
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #0c1317;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
      </style>
    </head>
    <body>
      ${content}
    </body>
    </html>
  `;
  res.send(html);
});

// 2. Status em JSON
app.get("/status", (req, res) => {
  res.json({
    status: connectionState,
    connected: connectionState === "CONNECTED",
    number: connectedNumber
  });
});

// 3. Endpoint de Envio de Mensagem com Resolução Inteligente de JID
app.post("/send-message", async (req, res) => {
  const { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({ error: "Campos 'number' e 'message' são obrigatórios." });
  }

  if (connectionState !== "CONNECTED" || !sock) {
    return res.status(503).json({ error: "WhatsApp não está conectado no momento." });
  }

  try {
    let cleanNumber = String(number).replace(/\D/g, "");
    if (cleanNumber.length === 10 || cleanNumber.length === 11) {
      cleanNumber = "55" + cleanNumber;
    }

    let targetJid = `${cleanNumber}@s.whatsapp.net`;

    // Consulta os servidores do WhatsApp para obter o JID exato (com ou sem o 9)
    try {
      const results = await sock.onWhatsApp(cleanNumber);
      if (results && results.length > 0 && results[0].exists) {
        targetJid = results[0].jid;
      } else if (cleanNumber.length === 13 && cleanNumber.startsWith("55")) {
        // Tenta sem o 9º dígito
        const sem9 = cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        const resultsSem9 = await sock.onWhatsApp(sem9);
        if (resultsSem9 && resultsSem9.length > 0 && resultsSem9[0].exists) {
          targetJid = resultsSem9[0].jid;
        }
      } else if (cleanNumber.length === 12 && cleanNumber.startsWith("55")) {
        // Tenta com o 9º dígito
        const com9 = cleanNumber.substring(0, 4) + "9" + cleanNumber.substring(4);
        const resultsCom9 = await sock.onWhatsApp(com9);
        if (resultsCom9 && resultsCom9.length > 0 && resultsCom9[0].exists) {
          targetJid = resultsCom9[0].jid;
        }
      }
    } catch (e) {
      console.log("Erro na verificação de número:", e.message);
    }

    console.log(`[DISPARANDO WHATSAPP] Destino resolvido: ${targetJid}`);
    const sent = await sock.sendMessage(targetJid, { text: String(message) });
    
    return res.json({
      success: true,
      messageId: sent.key.id,
      recipient: targetJid
    });
  } catch (err) {
    console.error("Erro ao enviar mensagem WhatsApp:", err);
    return res.status(500).json({ error: "Falha ao enviar mensagem: " + err.message });
  }
});

startWhatsApp();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 DLuz WhatsApp Baileys API rodando na porta ${PORT}`);
});
