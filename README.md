# Multifunctional Arduino 4WD Rover

A modern, multifunctional 4-Wheel Drive (4WD) smart rover powered by an **Arduino Uno** and controlled via a mobile-first **Web Bluetooth App**.

---

## 🚀 Features & Operating Modes

The rover supports 5 operational modes dynamically switchable from the web interface:

- **Mode 0 (`M0`) — Manual Remote Control:**
  - Real-time directional driving (`Forward`, `Backward`, `Left`, `Right`, `Stop`).
  - Adjustable speed throttle (PWM steps 0–9).
- **Mode 1 (`M1`) — Autonomous Line Following:**
  - High-precision tracking using a 3-channel Infrared (IR) sensor array.
- **Mode 2 (`M2`) — Autonomous Obstacle Avoidance:**
  - Sweeping ultrasonic radar using HC-SR04 mounted on an SG90 servo motor.
  - Automatically scans left and right when an obstacle is detected to navigate a clear path.
- **Mode 3 (`M3`) — Draw-a-Road / Vector Path Planner:**
  - Draw any freehand route on the interactive HTML5 vector canvas.
  - Converts drawn strokes into sequential timed motor vectors (`D:F:<ms>`, `D:L:<ms>`, etc.) streamed to the rover.
- **Mode 4 (`M4`) — Emergency Stop:**
  - Instant hardware brake cutting motor driver PWM immediately.

---

## 🛠️ Hardware Stack

- **Microcontroller:** Arduino Uno (ATmega328P)
- **Motor Driver:** L298N Dual H-Bridge Motor Driver
- **Chassis:** 4WD Robot Smart Car Chassis with DC Geared Motors
- **Wireless Communication:** HM-10 / BT05 BLE Bluetooth 4.0 Module
- **Sensors & Actuators:**
  - HC-SR04 Ultrasonic Distance Sensor
  - SG90 Micro Servo Motor
  - 3-Channel TCRT5000 / Infrared Line Tracking Sensor Module
- **Power Supply:** 2x 18650 Li-ion batteries (7.4V - 8.4V)

---

## 📁 Repository Structure

```
├── .gitignore          # Git exclusion rules
├── README.md           # Project documentation
├── app/                # Web Bluetooth Controller Frontend
│   ├── index.html      # Mobile-first cyber-tech web controller UI
│   ├── style.css       # Responsive dark-theme styling
│   ├── app.js          # Core app controller and mode state machine
│   ├── bluetooth.js    # Web Bluetooth API communication handler
│   ├── draw-canvas.js  # HTML5 Canvas vector path planning logic
│   ├── package.json    # Vite frontend dependencies
│   └── vercel.json     # Deployment configuration for Vercel
├── code/
│   └── rover/
│       └── rover.ino   # Complete Arduino Uno C++ firmware
```

---

## 💻 Getting Started

### 1. Upload Arduino Firmware
1. Open [`code/rover/rover.ino`](code/rover/rover.ino) in the **Arduino IDE**.
2. Select Board: **Arduino Uno**.
3. Select your serial **Port**.
4. Click **Upload**.

### 2. Run Web Controller Locally
Make sure you have [Node.js](https://nodejs.org/) installed:

```bash
cd app
npm install
npm run dev
```

Open the displayed local URL (e.g. `http://localhost:5174/`) in Google Chrome, Microsoft Edge, or any Web Bluetooth-supported browser.

---

## 📱 Mobile Connection
1. Power on the Rover.
2. Open the Web Controller on your phone or laptop.
3. Tap **`⚡ CONNECT`** and choose your **HM-10 / BT05** device.
4. Drive manually, trigger autonomous modes, or draw custom paths!

---

## 📄 License
This project is open-source under the MIT License.
