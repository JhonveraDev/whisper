const TARGET_SAMPLE_RATE = 24000;

const inputLanguageEl = document.getElementById("inputLanguage");
const outputLanguageEl = document.getElementById("outputLanguage");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const statusEl = document.getElementById("status");

let socket;
let mediaStream;
let captureContext;
let playbackContext;
let processor;
let source;
let nextPlaybackTime = 0;

function setStatus(status) {
  statusEl.textContent = status;
  console.log("[status]", status);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function downsampleBuffer(input, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) {
    return input;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }

    output[i] = count > 0 ? sum / count : 0;
  }

  return output;
}

function floatToPcm16(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

function pcm16ToFloat32(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const output = new Float32Array(arrayBuffer.byteLength / 2);

  for (let i = 0; i < output.length; i += 1) {
    const value = view.getInt16(i * 2, true);
    output[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }

  return output;
}

function playPcm16(base64Audio, sampleRate) {
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate });
  }

  const audioData = pcm16ToFloat32(base64ToArrayBuffer(base64Audio));
  const audioBuffer = playbackContext.createBuffer(1, audioData.length, sampleRate);
  audioBuffer.copyToChannel(audioData, 0);

  const bufferSource = playbackContext.createBufferSource();
  bufferSource.buffer = audioBuffer;
  bufferSource.connect(playbackContext.destination);

  const now = playbackContext.currentTime;
  if (nextPlaybackTime < now) {
    nextPlaybackTime = now + 0.05;
  }

  bufferSource.start(nextPlaybackTime);
  nextPlaybackTime += audioBuffer.duration;
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener("open", () => {
    setStatus("connected");
    socket.send(JSON.stringify({
      type: "start",
      inputLanguage: inputLanguageEl.value,
      outputLanguage: outputLanguageEl.value
    }));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "status") {
      setStatus(message.state);
      return;
    }

    if (message.type === "translated_audio") {
      setStatus("playing");
      playPcm16(message.audio, message.sampleRate || TARGET_SAMPLE_RATE);
      return;
    }

    if (message.type === "error") {
      setStatus(`error: ${message.message}`);
      console.error(message.message);
    }
  });

  socket.addEventListener("close", () => {
    setStatus("disconnected");
  });
}

async function startCapture() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  captureContext = new AudioContext();
  source = captureContext.createMediaStreamSource(mediaStream);
  processor = captureContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(input, captureContext.sampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatToPcm16(downsampled);

    socket.send(JSON.stringify({
      type: "audio_chunk",
      audio: arrayBufferToBase64(pcm16)
    }));
  };

  source.connect(processor);
  processor.connect(captureContext.destination);
  setStatus("listening");
}

async function start() {
  startButton.disabled = true;
  stopButton.disabled = false;
  await startCapture();
  connectSocket();
}

function stop(finalStatus = "stopped") {
  if (processor) {
    processor.disconnect();
    processor = null;
  }

  if (source) {
    source.disconnect();
    source = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (captureContext) {
    captureContext.close();
    captureContext = null;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stop" }));
    socket.close();
  }
  socket = null;

  nextPlaybackTime = 0;
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus(finalStatus);
}

startButton.addEventListener("click", () => {
  start().catch((error) => {
    console.error(error);
    const message = error.name === "NotAllowedError" || error.message.includes("Permission denied")
      ? "microphone permission denied. Allow microphone access for localhost, then refresh."
      : error.message;
    stop(`error: ${message}`);
  });
});

stopButton.addEventListener("click", stop);
