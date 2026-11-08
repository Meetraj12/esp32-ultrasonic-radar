const express = require("express");
const http = require("http");
const cors = require("cors");
const os = require("os");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: "10kb" }));

const io = new Server(server, {
  cors: { origin: "*" }
});

let latestReading = {
  angle: 0,
  distance: 0,
  detected: false,
  updatedAt: null,
  isMock: false
};

// Simulation / Mock State
let isMockActive = process.argv.includes("--mock");
let mockInterval = null;
let mockAngle = 0;
let mockDirection = 1;
const MOCK_STEP = 3;
const MOCK_SPEED_MS = 60;

function generateMockReading(angle) {
  // Simulate two objects in the field:
  // Target 1: at ~45 degrees, ~38cm away
  // Target 2: at ~125 degrees, ~85cm away
  let distance = 0;
  let detected = false;

  if (Math.abs(angle - 45) <= 6) {
    const jitter = (Math.random() - 0.5) * 1.5;
    distance = Math.round((38 + jitter) * 10) / 10;
    detected = true;
  } else if (Math.abs(angle - 125) <= 7) {
    const jitter = (Math.random() - 0.5) * 2.0;
    distance = Math.round((85 + jitter) * 10) / 10;
    detected = true;
  }

  return {
    angle,
    distance,
    detected,
    updatedAt: new Date().toISOString(),
    isMock: true
  };
}

function startMock() {
  if (mockInterval) return;
  isMockActive = true;
  console.log(">> Radar Mock/Simulation MODE ACTIVE <<");

  mockInterval = setInterval(() => {
    latestReading = generateMockReading(mockAngle);
    io.emit("radar-reading", latestReading);

    mockAngle += mockDirection * MOCK_STEP;
    if (mockAngle >= 180) {
      mockAngle = 180;
      mockDirection = -1;
    } else if (mockAngle <= 0) {
      mockAngle = 0;
      mockDirection = 1;
    }
  }, MOCK_SPEED_MS);

  io.emit("mock-status", { active: true });
}

function stopMock() {
  if (!mockInterval) return;
  clearInterval(mockInterval);
  mockInterval = null;
  isMockActive = false;
  console.log(">> Radar Mock/Simulation MODE STOPPED <<");
  io.emit("mock-status", { active: false });
}

if (isMockActive) {
  startMock();
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "ESP32 ultrasonic radar backend",
    isMockActive,
    latestReading
  });
});

app.get("/api/latest", (_req, res) => {
  res.json(latestReading);
});

app.get("/api/mock/status", (_req, res) => {
  res.json({ active: isMockActive });
});

app.post("/api/mock/toggle", (_req, res) => {
  if (isMockActive) {
    stopMock();
  } else {
    startMock();
  }
  res.json({ active: isMockActive });
});

app.post("/radar", (req, res) => {
  const { angle, distance, detected } = req.body || {};

  if (
    typeof angle !== "number" || angle < 0 || angle > 180 ||
    typeof distance !== "number" || !Number.isFinite(distance) ||
    typeof detected !== "boolean"
  ) {
    return res.status(400).json({
      error: "Expected angle (0-180), distance (number), detected (boolean)"
    });
  }

  // If real data arrives from ESP32, automatically pause mock if it was running
  if (isMockActive && !req.query.allowMock) {
    console.log("Real ESP32 data received. Suspending mock mode.");
    stopMock();
  }

  latestReading = {
    angle: Math.round(angle),
    distance: Math.round(distance * 10) / 10,
    detected,
    updatedAt: new Date().toISOString(),
    isMock: false
  };

  io.emit("radar-reading", latestReading);
  res.status(200).json({ received: true });
});

io.on("connection", (socket) => {
  console.log(`[Socket] Dashboard connected: ${socket.id}`);
  socket.emit("radar-reading", latestReading);
  socket.emit("mock-status", { active: isMockActive });

  socket.on("toggle-mock", () => {
    if (isMockActive) {
      stopMock();
    } else {
      startMock();
    }
  });

  socket.on("disconnect", () => {
    console.log(`[Socket] Dashboard disconnected: ${socket.id}`);
  });
});

function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push({ interface: name, address: net.address });
      }
    }
  }
  return ips;
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n=======================================================");
  console.log(`  RADAR BACKEND SERVER RUNNING ON PORT ${PORT}`);
  console.log("=======================================================");
  console.log(`Local Access:   http://localhost:${PORT}`);
  
  const localIps = getLocalIpAddresses();
  if (localIps.length > 0) {
    console.log("Available Network Interfaces (for ESP32 and mobile/tablet):");
    localIps.forEach((item) => {
      console.log(`  - [${item.interface}] http://${item.address}:${PORT}`);
      console.log(`    ESP32 SERVER_URL -> http://${item.address}:${PORT}/radar`);
    });
  }
  console.log(`Simulation Mode: ${isMockActive ? "ACTIVE" : "OFF (use 'npm run mock' to activate)"}`);
  console.log("=======================================================\n");
});
