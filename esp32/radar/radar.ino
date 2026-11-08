/*
 * ESP32 Ultrasonic Radar
 * 
 * Hardware:
 *   - ESP32 Development Board
 *   - HC-SR04 Ultrasonic Distance Sensor
 *   - SG90 (or MG90S) Micro Servo
 * 
 * Wiring:
 *   HC-SR04:
 *     - VCC  -> 5V (VIN on ESP32 or external 5V)
 *     - GND  -> ESP32 GND
 *     - TRIG -> GPIO 5
 *     - ECHO -> GPIO 18 (USE VOLTAGE DIVIDER: 1kΩ from ECHO to GPIO18, 2kΩ from GPIO18 to GND)
 * 
 *   SG90 Servo:
 *     - Signal (Orange/Yellow) -> GPIO 19
 *     - V+ (Red)               -> External regulated 5V supply (or VIN if USB provides enough current)
 *     - GND (Brown/Black)      -> External 5V GND (MUST connect common ground with ESP32 GND)
 * 
 *   Status LED:
 *     - GPIO 2 (Built-in blue LED on most ESP32 boards)
 * 
 * Required Arduino Libraries:
 *   - ESP32Servo (by Kevin Harrington / John K. Bennett) - Install from Arduino IDE Library Manager
 *   - WiFi and HTTPClient (Included with ESP32 Arduino Board Package)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>

// ======================== CONFIGURATION ========================
// 1. Enter your Wi-Fi credentials:
const char* WIFI_SSID     = "Pulin";
const char* WIFI_PASSWORD = "12344321";

// 2. Set this to the computer's current Wi-Fi IPv4 address (backend port 5000).
const char* SERVER_URL = "http://10.136.243.77:5000/radar";

// Pin definitions
#define TRIG_PIN       5
#define ECHO_PIN       18
#define SERVO_PIN      19
#define STATUS_LED_PIN 2

// Radar scanning parameters
const int   MIN_ANGLE       = 0;
const int   MAX_ANGLE       = 180;
const int   ANGLE_STEP      = 3;
const float MAX_DISTANCE_CM = 250.0;

// Settle and loop delays (in milliseconds)
const int SERVO_SETTLE_MS = 60;
const int LOOP_DELAY_MS   = 20;
// ===============================================================

Servo radarServo;
WiFiClient wifiClient;

int angle = MIN_ANGLE;
int scanDirection = 1; // +1 for 0->180, -1 for 180->0
unsigned long lastWiFiCheck = 0;

// Measure distance using HC-SR04
float measureDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  // Measure echo pulse (30000us timeout = ~5.1m max)
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);

  if (duration == 0) {
    return -1.0; // Timeout / no return echo
  }

  // Speed of sound: 343 m/s = 0.0343 cm/us
  float distance = (duration * 0.0343) / 2.0;

  if (distance < 2.0 || distance > MAX_DISTANCE_CM) {
    return -1.0; // Out of valid radar detection window
  }

  return distance;
}

// Connect to Wi-Fi network
void connectToWiFi() {
  Serial.println();
  Serial.print("[WiFi] Connecting to: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 25) {
    delay(400);
    digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN)); // Flash LED
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(STATUS_LED_PIN, HIGH); // Solid ON when connected
    Serial.println();
    Serial.println("[WiFi] Connected successfully!");
    Serial.print("[WiFi] ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WiFi] Target Server: ");
    Serial.println(SERVER_URL);
  } else {
    digitalWrite(STATUS_LED_PIN, LOW);
    Serial.println();
    Serial.println("[WiFi] Warning: Could not connect to Wi-Fi. Operating in offline/serial mode.");
    Serial.println("[WiFi] Will automatically retry in background.");
  }
}

// Send radar reading to Node.js backend
bool sendRadarData(int currentAngle, float distance, bool detected) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  HTTPClient http;
  http.begin(wifiClient, SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  // Allow time for Wi-Fi connection setup and the backend response.
  http.setTimeout(1000);

  char payload[96];
  snprintf(payload, sizeof(payload),
    "{\"angle\":%d,\"distance\":%.1f,\"detected\":%s}",
    currentAngle,
    detected ? distance : 0.0,
    detected ? "true" : "false"
  );

  int httpCode = http.POST(payload);
  if (httpCode < 0) {
    Serial.print("[NET] POST failed: ");
    Serial.println(HTTPClient::errorToString(httpCode));
  } else if (httpCode != HTTP_CODE_OK) {
    Serial.printf("[NET] Backend returned HTTP %d\n", httpCode);
  }
  http.end();

  return (httpCode >= 200 && httpCode < 300);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("==========================================");
  Serial.println("     ESP32 ULTRASONIC RADAR STARTING      ");
  Serial.println("==========================================");

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);

  // Setup ESP32 Servo
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  radarServo.setPeriodHertz(50); // Standard 50Hz servo PWM
  radarServo.attach(SERVO_PIN, 500, 2400);

  // Move servo to starting position
  radarServo.write(MIN_ANGLE);
  delay(600);

  // Connect to Wi-Fi
  connectToWiFi();

  Serial.println("Radar scan loop initiated.");
  Serial.println("------------------------------------------");
}

void loop() {
  // Check Wi-Fi connection periodically
  if (millis() - lastWiFiCheck > 10000) {
    lastWiFiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      digitalWrite(STATUS_LED_PIN, LOW);
      WiFi.reconnect();
    } else {
      digitalWrite(STATUS_LED_PIN, HIGH);
    }
  }

  // 1. Move servo to current angle
  radarServo.write(angle);

  // 2. Allow servo to reach target position
  delay(SERVO_SETTLE_MS);

  // 3. Measure ultrasonic distance
  float distance = measureDistanceCm();
  bool detected = (distance > 0.0);

  // 4. Send data to server over HTTP
  bool sent = sendRadarData(angle, distance, detected);

  // 5. Output to Serial Monitor
  Serial.printf("[RADAR] Angle: %3d deg | Dist: ", angle);
  if (detected) {
    Serial.printf("%5.1f cm", distance);
  } else {
    Serial.print("   ---  ");
  }
  Serial.printf(" | Status: %s | Net: %s\n",
    detected ? "OBJECT DETECTED" : "CLEAR",
    (WiFi.status() == WL_CONNECTED) ? (sent ? "SENT" : "FAIL") : "OFFLINE"
  );

  // 6. Step scanning angle
  angle += scanDirection * ANGLE_STEP;

  // Reverse sweep at limits
  if (angle >= MAX_ANGLE) {
    angle = MAX_ANGLE;
    scanDirection = -1;
  } else if (angle <= MIN_ANGLE) {
    angle = MIN_ANGLE;
    scanDirection = 1;
  }

  delay(LOOP_DELAY_MS);
}
