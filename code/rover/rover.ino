/*
 ============================================================================
  Multifunctional 4WD Arduino Uno Rover (Optimized & Responsive)
  
  Operating Modes:
    M0 = Remote Control Mode (F, B, L, R, S, 0-9)
    M1 = Autonomous Line Following (3-Channel IR with Live Telemetry)
    M2 = Autonomous Obstacle Avoidance (Ultrasonic + SG90 Servo Scan)
    M3 = Draw-a-Road / Paint-a-Path (e.g. D:F:1000, D:L:500, D:S)
    M4 or S = Emergency Stop (Immediate Hardware Halt)
 ============================================================================
*/

#include <Arduino.h>
#include <SoftwareSerial.h>
#include <Servo.h>

// ============================================================================
// 1. PIN DEFINITIONS
// ============================================================================
// Bluetooth HM-10 (D2=RX from HM-10 TX, D3=TX to HM-10 RX)
const int PIN_BT_RX   = 2;
const int PIN_BT_TX   = 3;

// L298N Motor Driver Pins
const int PIN_ENA     = 5;   // Left Motors Speed (Hardware PWM, Timer 0)
const int PIN_IN1     = 6;   // Left Motors Direction 1
const int PIN_IN2     = 7;   // Left Motors Direction 2
const int PIN_IN3     = 8;   // Right Motors Direction 1
const int PIN_IN4     = 9;   // Right Motors Direction 2
const int PIN_ENB     = 10;  // Right Motors Speed (Hardware PWM, Timer 1)

// SG90 Servo Motor
const int PIN_SERVO   = 11;

// HC-SR04 Ultrasonic Sensor
const int PIN_TRIG    = 12;
const int PIN_ECHO    = 13;

// 3-Channel Infrared Line Tracking Sensor (A0, A1, A2 used as digital)
const int PIN_IR_L    = A0;  // Left Sensor
const int PIN_IR_C    = A1;  // Center Sensor
const int PIN_IR_R    = A2;  // Right Sensor

// ============================================================================
// 2. CONFIGURATION (Easy to Adjust)
// ============================================================================
// Change to 'true' if wheels rotate in the wrong direction
const bool LEFT_REVERSED   = false;
const bool RIGHT_REVERSED  = false;

// Line sensor polarity: LOW if sensor reads LOW on black line, else HIGH
const bool LINE_STATE      = LOW;

// Obstacle detection threshold (in cm)
const int OBSTACLE_DIST    = 20;

// Auto-stop timeout if Bluetooth connection drops in Remote Mode (milliseconds)
const unsigned long BT_TIMEOUT = 3000;

// Speed levels '0' to '9' mapped to PWM values (0 to 255)
const int SPEED_LEVELS[10] = {0, 28, 56, 85, 113, 142, 170, 198, 227, 255};
int motorSpeed = 160; // Safe default cruising speed

// ============================================================================
// 3. GLOBAL VARIABLES
// ============================================================================
SoftwareSerial bt(PIN_BT_RX, PIN_BT_TX);
Servo scanServo;

enum Mode { REMOTE, LINE, OBSTACLE, DRAW, STOP };
volatile Mode currentMode = REMOTE;

int lastLineTurn = 0;              // -1 = Left, 1 = Right (for lost line recovery)
unsigned long lastCommandTime = 0; // Tracks last valid remote command
bool isMoving = false;

// Forward declaration
void checkSerial();
void stopMotors();

// ============================================================================
// 4. MOTOR CONTROL FUNCTIONS
// ============================================================================
// Core motor driver: dir = 1 (Forward), -1 (Backward), 0 (Stop)
void setMotors(int leftDir, int rightDir, int leftSpeed, int rightSpeed) {
  if (LEFT_REVERSED)  leftDir  = -leftDir;
  if (RIGHT_REVERSED) rightDir = -rightDir;

  // Left Motors
  analogWrite(PIN_ENA, leftSpeed);
  digitalWrite(PIN_IN1, leftDir > 0 ? HIGH : LOW);
  digitalWrite(PIN_IN2, leftDir < 0 ? HIGH : LOW);

  // Right Motors
  analogWrite(PIN_ENB, rightSpeed);
  digitalWrite(PIN_IN3, rightDir > 0 ? HIGH : LOW);
  digitalWrite(PIN_IN4, rightDir < 0 ? HIGH : LOW);

  isMoving = (leftDir != 0 || rightDir != 0);
}

// Simple directional movement using current speed
void drive(int leftDir, int rightDir) {
  setMotors(leftDir, rightDir, motorSpeed, motorSpeed);
}

void stopMotors() {
  setMotors(0, 0, 0, 0);
}

// ============================================================================
// 5. SENSOR & SERVO HELPERS (Timer-Conflict Free)
// ============================================================================
// Send status message to Phone via BLE and USB Serial Monitor
void sendMsg(const char* msg) {
  bt.println(msg);
  Serial.print(F("[ROVER] "));
  Serial.println(msg);
}

// Restore Timer 1 Phase Correct PWM mode so Pin 10 (ENB) retains full PWM control
void restoreTimer1PWM() {
#if defined(TCCR1A) && defined(WGM10)
  TCCR1A |= _BV(WGM10); // 8-bit Phase Correct PWM
#endif
}

// Attach servo only when actively panning, and detach after to eliminate jitter & timer clash
void attachServo() {
  if (!scanServo.attached()) {
    scanServo.attach(PIN_SERVO);
  }
}

void detachServo() {
  if (scanServo.attached()) {
    scanServo.detach();
    restoreTimer1PWM();
  }
}

void setServo(int angle) {
  attachServo();
  scanServo.write(constrain(angle, 15, 165)); // Prevent mechanical strain
}

// Measure distance in centimeters using HC-SR04
long getDistance() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  long duration = pulseIn(PIN_ECHO, HIGH, 25000UL); // 25ms timeout (~400cm)
  if (duration == 0) return 999;                    // Out of range / clear
  return duration / 58;                             // Convert to cm
}

// Non-blocking interruptible delay for autonomous loops:
// Returns false immediately if an emergency stop or mode switch command is received!
bool safeDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    checkSerial();
    if (currentMode != OBSTACLE && currentMode != LINE) {
      stopMotors();
      return false; // Abort current action immediately
    }
    delay(5);
  }
  return true;
}

// ============================================================================
// 6. OPERATING MODES
// ============================================================================

// 1. Autonomous Line Following (Smooth Differential Steering + Telemetry)
void runLineFollowing() {
  bool L = (digitalRead(PIN_IR_L) == LINE_STATE);
  bool C = (digitalRead(PIN_IR_C) == LINE_STATE);
  bool R = (digitalRead(PIN_IR_R) == LINE_STATE);

  // Send real-time sensor telemetry to Web App every 200ms
  static unsigned long lastIrTelemetry = 0;
  if (millis() - lastIrTelemetry > 200) {
    lastIrTelemetry = millis();
    char buf[36];
    snprintf(buf, sizeof(buf), "[IR SENSORS] L:%d C:%d R:%d", L ? 1 : 0, C ? 1 : 0, R ? 1 : 0);
    sendMsg(buf);
  }

  if (!L && C && !R) {
    // Centered -> Go straight
    setMotors(1, 1, 140, 140);
    lastLineTurn = 0;
  } else if (L && !R) {
    // Drifting right -> Steer left (slow left, fast right)
    setMotors(1, 1, 60, 170);
    lastLineTurn = -1;
  } else if (!L && R) {
    // Drifting left -> Steer right (fast left, slow right)
    setMotors(1, 1, 170, 60);
    lastLineTurn = 1;
  } else if (L && C && R) {
    // Intersection / Crossroad -> Move slowly forward
    setMotors(1, 1, 90, 90);
  } else if (!L && !C && !R) {
    // Line lost -> Pivot gently toward last known direction
    if (lastLineTurn == -1)      setMotors(-1, 1, 140, 140); // Pivot left
    else if (lastLineTurn == 1)  setMotors(1, -1, 140, 140); // Pivot right
    else                         stopMotors();
  }
}

// 2. Autonomous Obstacle Avoidance (Look Left & Right + Live Distance Telemetry)
void runObstacleAvoidance() {
  long distance = getDistance();

  // Send live distance telemetry to Web App radar every 200ms
  static unsigned long lastDistTelemetry = 0;
  if (millis() - lastDistTelemetry > 200) {
    lastDistTelemetry = millis();
    char buf[32];
    snprintf(buf, sizeof(buf), "[DISTANCE FRONT] %ld cm", distance);
    sendMsg(buf);
  }

  if (distance > OBSTACLE_DIST) {
    drive(1, 1); // Path clear -> Move forward
  } else {
    // Obstacle detected: Stop and back up slightly
    stopMotors();
    sendMsg("OBSTACLE:DETECTED");
    drive(-1, -1);
    if (!safeDelay(250)) return;
    stopMotors();

    // Look left (150 degrees)
    setServo(150);
    if (!safeDelay(300)) { detachServo(); return; }
    long leftDist = getDistance();

    // Look right (30 degrees)
    setServo(30);
    if (!safeDelay(500)) { detachServo(); return; }
    long rightDist = getDistance();

    // Re-center servo and release timer to free Pin 10 PWM
    setServo(90);
    if (!safeDelay(250)) { detachServo(); return; }
    detachServo();

    // Steer toward the side with more space
    if (leftDist > rightDist && leftDist > OBSTACLE_DIST) {
      sendMsg("OBSTACLE:LEFT");
      drive(-1, 1); // Turn left
      if (!safeDelay(400)) return;
    } else if (rightDist >= leftDist && rightDist > OBSTACLE_DIST) {
      sendMsg("OBSTACLE:RIGHT");
      drive(1, -1); // Turn right
      if (!safeDelay(400)) return;
    } else {
      // Dead end -> Turn around
      sendMsg("OBSTACLE:AROUND");
      drive(1, -1);
      if (!safeDelay(800)) return;
    }
    stopMotors();
  }
}

// 3. Draw-a-Road Timed Movement (Interruptible by Emergency Stop / Clear)
void executeDraw(char dir, unsigned long durationMs) {
  switch (dir) {
    case 'F': drive(1, 1);   break;
    case 'B': drive(-1, -1); break;
    case 'L': drive(-1, 1);  break;
    case 'R': drive(1, -1);  break;
    default: return;
  }

  // Non-blocking timer: immediately cancels if user sends 'S', 'M', or 'D:S'
  unsigned long start = millis();
  while (millis() - start < durationMs) {
    if (bt.available() > 0 || Serial.available() > 0) {
      char c = (bt.available() > 0) ? bt.peek() : Serial.peek();
      if (c == 'S' || c == 's' || c == 'M' || c == 'm' || c == 'D' || c == 'd') {
        stopMotors();
        sendMsg("DRAW:STOPPED");
        return;
      }
    }
    delay(5);
  }
  stopMotors();
  sendMsg("DRAW:DONE");
}

// ============================================================================
// 7. COMMAND PARSER (Bluetooth & USB Serial)
// ============================================================================
void handleCommand(char* cmd) {
  if (strlen(cmd) == 0) return;

  // 1. Emergency Stop ('S' or 'M4')
  if (cmd[0] == 'S' || cmd[0] == 's' || (cmd[0] == 'M' && cmd[1] == '4')) {
    stopMotors();
    currentMode = STOP;
    detachServo();
    sendMsg("EMERGENCY_STOP");
    return;
  }

  // 2. Mode Switches ('M0', 'M1', 'M2', 'M3')
  if (cmd[0] == 'M' || cmd[0] == 'm') {
    stopMotors();
    detachServo();
    lastLineTurn = 0;

    switch (cmd[1]) {
      case '0': currentMode = REMOTE;   sendMsg("MODE:REMOTE");   break;
      case '1': currentMode = LINE;     sendMsg("MODE:LINE");     break;
      case '2': currentMode = OBSTACLE; sendMsg("MODE:OBSTACLE"); break;
      case '3': currentMode = DRAW;     sendMsg("MODE:DRAW");     break;
      default:  sendMsg("ERROR:MODE");                            break;
    }
    return;
  }

  // 3. Speed Commands ('0' to '9')
  if (strlen(cmd) == 1 && cmd[0] >= '0' && cmd[0] <= '9') {
    motorSpeed = SPEED_LEVELS[cmd[0] - '0'];
    analogWrite(PIN_ENA, motorSpeed);
    analogWrite(PIN_ENB, motorSpeed);
    sendMsg("SPEED:OK");
    return;
  }

  // 4. Draw-a-Road Commands ("D:F:1000", "D:L:500", "D:S")
  if (cmd[0] == 'D' && cmd[1] == ':') {
    currentMode = DRAW;
    if (cmd[2] == 'S' || cmd[2] == 's') {
      stopMotors();
      sendMsg("DRAW:STOP");
    } else if (cmd[3] == ':') {
      char dir = cmd[2];
      unsigned long duration = atol(&cmd[4]);
      if (duration > 15000) duration = 15000; // Cap at 15 seconds for safety
      executeDraw(dir, duration);
    }
    return;
  }

  // 5. Remote Drive Commands ('F', 'B', 'L', 'R')
  if (currentMode == REMOTE) {
    lastCommandTime = millis();
    switch (cmd[0]) {
      case 'F': case 'f': drive(1, 1);   sendMsg("MOTOR:FORWARD");  break;
      case 'B': case 'b': drive(-1, -1); sendMsg("MOTOR:BACKWARD"); break;
      case 'L': case 'l': drive(-1, 1);  sendMsg("MOTOR:LEFT");     break;
      case 'R': case 'r': drive(1, -1);  sendMsg("MOTOR:RIGHT");    break;
      default: sendMsg("ERROR:CMD"); break;
    }
  }
}

// Reads incoming text lines from either Bluetooth HM-10 or USB Serial Monitor
// Includes an 80ms idle timeout so single-character or no-newline commands execute cleanly!
void checkSerial() {
  static char buffer[32];
  static int idx = 0;
  static unsigned long lastCharTime = 0;

  Stream* streams[2] = {&bt, &Serial};
  for (int i = 0; i < 2; i++) {
    while (streams[i]->available() > 0) {
      char c = (char)streams[i]->read();
      lastCharTime = millis();

      if (c == '\n' || c == '\r') {
        if (idx > 0) {
          buffer[idx] = '\0';
          handleCommand(buffer);
          idx = 0;
        }
      } else if (c != ' ' && idx < 31) {
        buffer[idx++] = c;
      }
    }
  }

  // Idle timeout: process command if sender didn't append newline (e.g. Serial Monitor "No line ending")
  if (idx > 0 && (millis() - lastCharTime > 80)) {
    buffer[idx] = '\0';
    handleCommand(buffer);
    idx = 0;
  }
}

// ============================================================================
// 8. ARDUINO SETUP & MAIN LOOP
// ============================================================================
void setup() {
  Serial.begin(9600);
  bt.begin(9600);

  // Initialize Motor Pins
  pinMode(PIN_ENA, OUTPUT);
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);
  pinMode(PIN_ENB, OUTPUT);
  stopMotors();

  // Initialize Ultrasonic Pins
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  // Center servo once, then detach to keep Timer 1 PWM active for Pin 10
  setServo(90);
  delay(300);
  detachServo();

  // Start in Remote Mode (Stationary)
  currentMode = REMOTE;
  lastCommandTime = millis();
  sendMsg("READY");
  sendMsg("MODE:REMOTE");
}

void loop() {
  // 1. Process incoming commands from Phone or Serial Monitor
  checkSerial();

  // 2. Fail-Safe: Stop motors in Remote Mode if connection drops for 3 seconds
  if (currentMode == REMOTE && isMoving && (millis() - lastCommandTime > BT_TIMEOUT)) {
    stopMotors();
    sendMsg("TIMEOUT:STOP");
  }

  // 3. Run autonomous behaviors
  if (currentMode == LINE) {
    runLineFollowing();
  } else if (currentMode == OBSTACLE) {
    runObstacleAvoidance();
  }
}
