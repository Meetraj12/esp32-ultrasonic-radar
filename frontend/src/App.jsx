import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

// Resolve backend server address dynamically:
// 1. Vite environment variable (if specified via .env or VITE_SERVER_URL)
// 2. Or automatically match the current host with port 5000 (localhost or LAN IP)
const getDefaultServerUrl = () => {
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL;
  }
  if (typeof window !== "undefined" && window.location.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:5000`;
  }
  return "http://localhost:5000";
};

const MAX_RANGE = 250; // Maximum distance in cm
const HISTORY_LIMIT = 180;

function playSonarPing() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  } catch {
    // Ignore audio autoplay restrictions
  }
}

function RadarCanvas({ readings, currentAngle, sweepDirection, maxRange }) {
  const width = 760;
  const height = 410;
  const cx = width / 2;
  const cy = height - 26;
  const radius = 340;

  // Polar projection: 0° is left, 90° is top, 180° is right
  const pointFor = (angle, distance) => {
    const radians = ((180 - angle) * Math.PI) / 180;
    const scaled = (Math.min(distance, maxRange) / maxRange) * radius;
    return {
      x: cx + Math.cos(radians) * scaled,
      y: cy - Math.sin(radians) * scaled
    };
  };

  const arcPath = (r) =>
    `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  const sweep = pointFor(currentAngle, radius);

  // Compute realistic trailing phosphor sweep sector
  const trailingSpan = 16;
  const trailingAngle =
    sweepDirection >= 0
      ? Math.max(0, currentAngle - trailingSpan)
      : Math.min(180, currentAngle + trailingSpan);

  const minA = Math.min(trailingAngle, currentAngle);
  const maxA = Math.max(trailingAngle, currentAngle);
  const pStart = pointFor(minA, radius);
  const pEnd = pointFor(maxA, radius);
  const sweepWedge = `M ${cx} ${cy} L ${pStart.x} ${pStart.y} A ${radius} ${radius} 0 0 1 ${pEnd.x} ${pEnd.y} Z`;

  return (
    <svg
      className="radar-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Live semicircular ultrasonic radar"
    >
      <defs>
        <radialGradient id="sweepGlow" cx="50%" cy="100%" r="90%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.08" />
          <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.5" />
        </radialGradient>
      </defs>

      {/* Concentric Range Rings */}
      {[0.25, 0.5, 0.75, 1].map((fraction) => (
        <g key={fraction}>
          <path d={arcPath(radius * fraction)} className="range-arc" />
          <text
            x={cx + 8}
            y={cy - radius * fraction + 4}
            className="range-label"
          >
            {Math.round(maxRange * fraction)} cm
          </text>
        </g>
      ))}

      {/* Bearing Guide Lines */}
      {[0, 30, 60, 90, 120, 150, 180].map((angle) => {
        const p = pointFor(angle, maxRange);
        const label = pointFor(angle, maxRange + 16);
        return (
          <g key={angle}>
            <line x1={cx} y1={cy} x2={p.x} y2={p.y} className="bearing-line" />
            <text
              x={label.x}
              y={label.y}
              textAnchor="middle"
              className="bearing-label"
            >
              {angle}°
            </text>
          </g>
        );
      })}

      {/* Trailing Radar Sweep Sector */}
      {minA !== maxA && (
        <path d={sweepWedge} fill="url(#sweepGlow)" opacity="0.65" />
      )}

      {/* Active Sweep Beam Line */}
      <line
        x1={cx}
        y1={cy}
        x2={sweep.x}
        y2={sweep.y}
        className="sweep-line"
      />

      {/* Detected Target Blips with Phosphor Decay */}
      {readings
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.detected && item.distance > 0)
        .map(({ item, index }) => {
          const p = pointFor(item.angle, item.distance);
          const opacity = Math.min(1, Math.max(0.25, (index + 1) / readings.length));
          const isCritical = item.distance <= 35;

          return (
            <g key={`${item.angle}-${index}`} opacity={opacity}>
              {isCritical && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r="9"
                  className="target-glow-ring"
                />
              )}
              <circle
                cx={p.x}
                cy={p.y}
                r={isCritical ? "6" : "4.5"}
                className={isCritical ? "target-dot critical" : "target-dot"}
              />
            </g>
          );
        })}

      {/* Origin Center Sensor Dot */}
      <circle cx={cx} cy={cy} r="7" className="origin-dot" />
      <text x={cx} y={cy + 20} textAnchor="middle" className="origin-label">
        HC-SR04 SENSOR
      </text>
    </svg>
  );
}

export default function App() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("radar-theme") || "dark"
  );
  const [serverUrl, setServerUrl] = useState(getDefaultServerUrl);
  const [showConfig, setShowConfig] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [isMocking, setIsMocking] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);

  const [latest, setLatest] = useState({
    angle: 0,
    distance: 0,
    detected: false,
    updatedAt: null,
    isMock: false
  });
  const [readings, setReadings] = useState([]);
  const [sweepDirection, setSweepDirection] = useState(1);
  const prevAngleRef = useRef(0);
  const socketRef = useRef(null);

  useEffect(() => {
    localStorage.setItem("radar-theme", theme);
  }, [theme]);

  // Connect to backend via Socket.IO
  useEffect(() => {
    const socket = io(serverUrl, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 5000
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnection("online");
    });

    socket.on("disconnect", () => {
      setConnection("offline");
    });

    socket.on("connect_error", () => {
      setConnection("offline");
    });

    socket.on("mock-status", (status) => {
      setIsMocking(Boolean(status?.active));
    });

    socket.on("radar-reading", (reading) => {
      if (!reading || typeof reading.angle !== "number") return;

      // Determine sweep direction (+1 forward, -1 backward)
      if (reading.angle > prevAngleRef.current) {
        setSweepDirection(1);
      } else if (reading.angle < prevAngleRef.current) {
        setSweepDirection(-1);
      }
      prevAngleRef.current = reading.angle;

      setLatest(reading);
      if (reading.isMock !== undefined) {
        setIsMocking(reading.isMock);
      }

      setReadings((previous) => [...previous, reading].slice(-HISTORY_LIMIT));

      // Sonar ping when an object is detected
      if (reading.detected && audioEnabled) {
        playSonarPing();
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [serverUrl, audioEnabled]);

  const toggleMock = () => {
    if (socketRef.current && connection === "online") {
      socketRef.current.emit("toggle-mock");
    } else {
      // Direct REST fallback
      fetch(`${serverUrl}/api/mock/toggle`, { method: "POST" })
        .then((res) => res.json())
        .then((data) => setIsMocking(data.active))
        .catch(() => alert("Could not reach backend server at " + serverUrl));
    }
  };

  const detectedCount = useMemo(
    () => readings.filter((item) => item.detected).length,
    [readings]
  );

  const proximityWarning = latest.detected && latest.distance > 0 && latest.distance <= 35;

  return (
    <main className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <p className="eyebrow">FIELD SYSTEMS / IOT RADAR</p>
            <h1>ULTRASONIC RADAR MONITOR</h1>
          </div>
        </div>

        <div className="header-actions">
          {/* Simulation Toggle Button */}
          <button
            className={`sim-button ${isMocking ? "active" : ""}`}
            onClick={toggleMock}
            title="Toggle simulated test targets (great for presentations without hardware)"
          >
            <span className="sim-dot" />
            {isMocking ? "SIMULATOR: ACTIVE" : "SIMULATE"}
          </button>

          {/* Audio Beep Toggle */}
          <button
            className={`audio-button ${audioEnabled ? "active" : ""}`}
            onClick={() => setAudioEnabled((v) => !v)}
            title="Sonar audio chime on target detection"
          >
            {audioEnabled ? "SONAR: ON" : "SONAR: MUTE"}
          </button>

          {/* Connection Pill */}
          <div
            className={`connection ${connection}`}
            onClick={() => setShowConfig((v) => !v)}
            title="Click to view/change backend URL"
            style={{ cursor: "pointer" }}
          >
            <span className="status-light" />
            {connection === "online"
              ? isMocking
                ? "LINK: SIMULATOR"
                : "LINK: ACTIVE"
              : connection === "connecting"
              ? "LINKING..."
              : "LINK: OFFLINE"}
          </div>

          {/* Theme Button */}
          <button
            className="theme-button"
            onClick={() =>
              setTheme((value) => (value === "dark" ? "light" : "dark"))
            }
          >
            {theme === "dark" ? "LIGHT" : "DARK"}
          </button>
        </div>
      </header>

      {/* Backend URL Configuration Drawer */}
      {showConfig && (
        <div className="config-banner">
          <div className="config-inner">
            <label htmlFor="backend-url-input">Backend Server URL:</label>
            <input
              id="backend-url-input"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://10.20.5.186:5000"
            />
            <button
              onClick={() => {
                setShowConfig(false);
              }}
            >
              SAVE
            </button>
            <span className="config-hint">
              Tip: Set this to your computer's IP address if opening on another device.
            </span>
          </div>
        </div>
      )}

      {/* Status Bar */}
      <section className="status-strip">
        <span>SCAN RANGE: 0°—180°</span>
        <span>MAX DETECTION: {MAX_RANGE} CM</span>
        <span>RESOLUTION: 3° STEP</span>
        <span>
          SOURCE:{" "}
          <strong style={{ color: isMocking ? "var(--danger)" : "var(--accent)" }}>
            {isMocking ? "SYNTHETIC SIMULATION" : "ESP32 HARDWARE"}
          </strong>
        </span>
      </section>

      {/* Main Grid */}
      <section className="main-grid">
        <article className="panel radar-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">POLAR RADAR PROJECTION</p>
              <h2>LIVE SWEEP DISPLAY</h2>
            </div>
            <div className="heading-badges">
              {proximityWarning && (
                <span className="proximity-badge">PROXIMITY ALERT</span>
              )}
              <span className="live-tag">
                <span /> LIVE
              </span>
            </div>
          </div>

          <div className="radar-wrap">
            <RadarCanvas
              readings={readings}
              currentAngle={latest.angle}
              sweepDirection={sweepDirection}
              maxRange={MAX_RANGE}
            />
          </div>

          <div className="scale-row">
            <span>0° / LEFT</span>
            <span>90° / CENTER</span>
            <span>180° / RIGHT</span>
          </div>
        </article>

        <aside className="side-column">
          {/* Bearing & Range Panel */}
          <article className="panel metric-panel">
            <p className="eyebrow">SERVO BEARING</p>
            <div className="big-value">
              {latest.angle}
              <small>°</small>
            </div>
            <div className="metric-rule" />
            <p className="eyebrow">MEASURED RANGE</p>
            <div className="big-value">
              {latest.detected ? latest.distance.toFixed(1) : "—"}
              <small>{latest.detected ? "cm" : "cm"}</small>
            </div>
            {latest.detected && (
              <p className="small-note" style={{ marginTop: "6px" }}>
                ≈ {(latest.distance / 2.54).toFixed(1)} inches
              </p>
            )}
          </article>

          {/* Detection Status Panel */}
          <article className="panel detection-panel">
            <p className="eyebrow">TARGET CLASSIFICATION</p>
            <div
              className={`target-state ${
                proximityWarning
                  ? "critical"
                  : latest.detected
                  ? "detected"
                  : "clear"
              }`}
            >
              <span className="target-indicator" />
              {proximityWarning
                ? "CRITICAL PROXIMITY"
                : latest.detected
                ? "TARGET ECHO DETECTED"
                : "RADAR HORIZON CLEAR"}
            </div>
            <p className="small-note">
              {proximityWarning
                ? "Obstacle within critical 35 cm zone!"
                : latest.detected
                ? `Ultrasonic echo returned at ${latest.angle}° bearing (${latest.distance.toFixed(1)} cm).`
                : "No obstacle echo returned within 250 cm limit."}
            </p>
          </article>

          {/* Session Data */}
          <article className="panel log-panel">
            <p className="eyebrow">TELEMETRY STATS</p>
            <div className="log-row">
              <span>Data Link</span>
              <strong>{connection.toUpperCase()}</strong>
            </div>
            <div className="log-row">
              <span>Samples Logged</span>
              <strong>{readings.length}</strong>
            </div>
            <div className="log-row">
              <span>Target Returns</span>
              <strong>{detectedCount}</strong>
            </div>
            <div className="log-row">
              <span>Last Packet</span>
              <strong>
                {latest.updatedAt
                  ? new Date(latest.updatedAt).toLocaleTimeString()
                  : "WAITING FOR DATA"}
              </strong>
            </div>
          </article>
        </aside>
      </section>

      <footer className="footer">
        <span>ESP32 (GPIO 5 / 18 / 19) • HC-SR04 • SG90 SERVO</span>
        <span>STATUS: {isMocking ? "SIMULATION BENCH" : "OPERATIONAL"}</span>
      </footer>
    </main>
  );
}
