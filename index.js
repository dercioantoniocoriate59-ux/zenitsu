const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Boom } = require("@hapi/boom");
const { ensureDirs } = require("./src/lib/helpers");

const PREFIXES = ["!", "."];
const COMMAND_DIR = path.join(__dirname, "src", "commands");

async function safeReact(sock, m, emoji) {
  try {
    if (!emoji) return;
    if (typeof emoji !== "string") return;
    if (emoji.trim() === "") return;
    await sock.sendMessage(m.key.remoteJid, {
      react: { text: emoji, key: m.key }
    });
  } catch (e) {}
}

function loadCommands() {
  const commands = new Map();
  try {
    const files = fs.readdirSync(COMMAND_DIR).filter(file => file.endsWith(".js"));
    for (const file of files) {
      try {
        const fullPath = path.join(COMMAND_DIR, file);
        delete require.cache[require.resolve(fullPath)];
        const cmd = require(fullPath);
        const validCategories = ["GERAIS", "MEGAS", "ADMIN", "DIVERSAO", "ANIME", "UTILS"];
        if (!cmd || typeof cmd.run !== "function" || !cmd.name || !validCategories.includes(cmd.category)) {
          console.log(`Comando inválido ignorado: ${file}`);
          continue;
        }
        commands.set(cmd.name.toLowerCase(), cmd);
        for (const alias of (Array.isArray(cmd.alias) ? cmd.alias : [])) {
          if (typeof alias === "string" && alias.trim()) commands.set(alias.toLowerCase(), cmd);
        }
      } catch (error) {
        console.log(`Falha ao carregar ${file}; bot continua:`, error);
      }
    }
  } catch (error) {
    console.log("Erro ao ler a pasta de comandos:", error);
  }
  console.log(`⚡ ${commands.size} nomes de comando carregados.`);
  return commands;
}

function getTextMessage(message = {}) {
  let msg = message;
  for (let i = 0; i < 5; i++) {
    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    else if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    else if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    else break;
  }
  return msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    "";
}

async function startBot() {
  ensureDirs();

  // Baileys é ESM; import dinâmico mantém os comandos em CommonJS.
  const baileys = await import("@whiskeysockets/baileys");
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage
  } = baileys;

  global.downloadMediaMessage = downloadMediaMessage;

  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"));
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (error) {
    console.log("Não foi possível obter a versão mais recente do WhatsApp; será usada a versão padrão.", error.message);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["ZENITSU", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => ({ conversation: "" })
  });

  sock.ev.on("creds.update", saveCreds);
  const commands = loadCommands();

  sock.ev.on("connection.update", update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n📲 Lê este QR Code com o WhatsApp do bot:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("⚡ ZENITSU ligado com sucesso!");
    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Ligação fechada.", statusCode, shouldReconnect ? "A reconectar..." : "Sessão terminada. Apaga auth/ e liga novamente para novo QR.");
      if (shouldReconnect) startBot().catch(err => console.log("Erro ao reconectar:", err));
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages || []) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const remoteJid = m.key.remoteJid || "";
        if (remoteJid === "status@broadcast") continue;

        const text = getTextMessage(m.message).trim();
        if (!text) continue;

        const prefix = PREFIXES.find(p => text.startsWith(p));
        if (!prefix) continue;

        const parts = text.slice(prefix.length).trim().split(/\s+/);
        const commandName = (parts.shift() || "").toLowerCase();
        const args = parts;
        if (!commandName) continue;

        const cmd = commands.get(commandName);
        if (!cmd) continue;

        try {
          await cmd.run({ sock, m, args });
        } catch (e) {
          console.log("Erro no comando", cmd.name, e);
        }
        try { await safeReact(sock, m, cmd.reaction); } catch (e) {}
      } catch (error) {
        console.log("Erro ao processar mensagem; bot continua:", error);
      }
    }
  });
}

startBot().catch(error => {
  console.log("Erro ao iniciar o ZENITSU:", error);
  process.exitCode = 1;
});
