import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function sendJson(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function buildInstructions(inputLanguage, outputLanguage) {
  return [
    "You are a live voice translation engine.",
    `The user will speak in ${inputLanguage}.`,
    `Translate everything they say into ${outputLanguage}.`,
    "Reply only with the translated speech.",
    "Do not answer questions, do not add explanations, and do not mention that you are translating.",
    "Keep the translation natural, brief, and faithful to the speaker."
  ].join(" ");
}

function createOpenAIRealtimeSocket(clientWs, { inputLanguage, outputLanguage }) {
  const endpoint = REALTIME_MODEL.includes("translate")
    ? "/v1/realtime/translations"
    : "/v1/realtime";
  const url = `wss://api.openai.com${endpoint}?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const openaiWs = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    }
  });

  openaiWs.on("open", () => {
    console.log("[openai] connected");

    sendJson(openaiWs, {
      type: "session.update",
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions: buildInstructions(inputLanguage, outputLanguage),
        output_modalities: ["audio"],
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true
            }
          },
          output: {
            format: {
              type: "audio/pcm"
            },
            voice: "marin"
          }
        }
      }
    });

    sendJson(clientWs, { type: "status", state: "connected" });
  });

  openaiWs.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.type === "error") {
      console.error("[openai] error", event.error);
      sendJson(clientWs, {
        type: "error",
        message: event.error?.message || "OpenAI realtime error"
      });
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      sendJson(clientWs, { type: "status", state: "listening" });
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      sendJson(clientWs, { type: "status", state: "translating" });
    }

    if (event.type === "response.output_audio.delta" && event.delta) {
      sendJson(clientWs, {
        type: "translated_audio",
        audio: event.delta,
        sampleRate: 24000
      });
    }

    if (event.type === "response.output_audio.done" || event.type === "response.done") {
      sendJson(clientWs, { type: "status", state: "connected" });
    }
  });

  openaiWs.on("close", (code, reason) => {
    const message = reason?.toString() || `closed with code ${code}`;
    console.log("[openai] disconnected", message);
    sendJson(clientWs, { type: "status", state: `disconnected: ${message}` });
  });

  openaiWs.on("error", (error) => {
    console.error("[openai] socket error", error.message);
    sendJson(clientWs, { type: "error", message: error.message });
  });

  return openaiWs;
}

wss.on("connection", (clientWs) => {
  let openaiWs = null;

  sendJson(clientWs, { type: "status", state: "connected" });

  clientWs.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendJson(clientWs, { type: "error", message: "Invalid JSON message" });
      return;
    }

    if (message.type === "start") {
      if (!OPENAI_API_KEY) {
        sendJson(clientWs, {
          type: "error",
          message: "Missing OPENAI_API_KEY. Copy .env.example to .env and set your key."
        });
        return;
      }

      if (openaiWs) {
        openaiWs.close();
      }

      openaiWs = createOpenAIRealtimeSocket(clientWs, {
        inputLanguage: message.inputLanguage || "English",
        outputLanguage: message.outputLanguage || "Spanish"
      });
      return;
    }

    if (message.type === "audio_chunk") {
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
        return;
      }

      sendJson(openaiWs, {
        type: "input_audio_buffer.append",
        audio: message.audio
      });
      return;
    }

    if (message.type === "stop") {
      if (openaiWs) {
        openaiWs.close();
        openaiWs = null;
      }
      sendJson(clientWs, { type: "status", state: "stopped" });
    }
  });

  clientWs.on("close", () => {
    if (openaiWs) {
      openaiWs.close();
      openaiWs = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Voice translation prototype running at http://localhost:${PORT}`);
});
