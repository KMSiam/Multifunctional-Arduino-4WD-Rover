import { RoverBluetooth } from './bluetooth.js';
import { DrawCanvas } from './draw-canvas.js';

// Speed level to PWM mapping (matches Arduino code)
const SPEED_PWM_MAP = [0, 28, 56, 85, 113, 142, 170, 198, 227, 255];

class RoverApp {
  constructor() {
    this.ble = new RoverBluetooth();
    this.currentMode = 0; // 0=Remote, 1=Line, 2=Obstacle, 3=Draw
    this.currentSpeed = 5;
    this.drawRoute = [];
    this.isExecutingRoute = false;
    this.activeDrawStepIndex = 0;

    this.initDOM();
    this.initBluetoothHandlers();
    this.initModeNavigation();
    this.initSpeedControls();
    this.initDPadControls();
    this.initEmergencyStop();
    this.initDrawCanvas();
    this.initTerminal();
    this.initKeyboardControls();
    this.initPWA();
  }

  initDOM() {
    // Header & Status
    this.btnConnect = document.getElementById('btn-connect');
    this.btnConnectText = document.getElementById('btn-connect-text');
    this.statusPill = document.getElementById('status-pill');
    this.statusText = document.getElementById('status-text');

    // Navigation Tabs & Panels
    this.modeTabs = document.querySelectorAll('.mode-tab');
    this.modePanels = document.querySelectorAll('.mode-panel');

    // Speed UI
    this.speedSlider = document.getElementById('speed-slider');
    this.speedDisplay = document.getElementById('speed-display');
    this.btnSpeedDown = document.getElementById('btn-speed-down');
    this.btnSpeedUp = document.getElementById('btn-speed-up');

    // D-Pad
    this.dpadButtons = document.querySelectorAll('.dpad-btn');

    // Line Tracking Visualizer
    this.irLeft = document.getElementById('ir-left');
    this.irCenter = document.getElementById('ir-center');
    this.irRight = document.getElementById('ir-right');
    this.lineStatusMsg = document.getElementById('line-status-msg');

    // Obstacle UI
    this.radarDistanceVal = document.getElementById('radar-distance-val');

    // Draw UI
    this.btnDrawClear = document.getElementById('btn-draw-clear');
    this.btnDrawSend = document.getElementById('btn-draw-send');
    this.drawSummary = document.getElementById('draw-summary');
    this.routeStepsBox = document.getElementById('route-steps-box');
    this.routeStepsList = document.getElementById('route-steps-list');

    // Emergency Stop & Terminal
    this.btnEStop = document.getElementById('btn-estop');
    this.terminalDrawer = document.getElementById('terminal-drawer');
    this.terminalToggle = document.getElementById('terminal-toggle');
    this.terminalLogs = document.getElementById('terminal-logs');
    this.btnClearLogs = document.getElementById('btn-clear-logs');
  }

  // ==========================================================================
  // BLUETOOTH INTEGRATION
  // ==========================================================================
  initBluetoothHandlers() {
    this.btnConnect.addEventListener('click', async () => {
      if (this.ble.isConnected) {
        this.ble.disconnect();
      } else {
        try {
          await this.ble.connect();
        } catch (err) {
          console.warn('Connection cancelled or failed:', err);
        }
      }
    });

    this.ble.onStatusChange = (status, message) => {
      this.logTerminal(`[BLE] ${message}`, 'system');

      if (status === 'connected') {
        this.statusPill.classList.add('connected');
        this.statusText.textContent = 'CONNECTED';
        this.btnConnect.classList.add('connected');
        this.btnConnectText.textContent = 'DISCONNECT';
      } else if (status === 'connecting') {
        this.statusPill.classList.remove('connected');
        this.statusText.textContent = 'CONNECTING...';
        this.btnConnectText.textContent = 'CONNECTING';
      } else {
        this.statusPill.classList.remove('connected');
        this.statusText.textContent = 'DISCONNECTED';
        this.btnConnect.classList.remove('connected');
        this.btnConnectText.textContent = 'CONNECT';
      }
    };

    this.ble.onDataReceived = (line) => {
      this.logTerminal(`[RX] ${line}`, 'rx');
      this.handleIncomingRoverData(line);
    };

    this.ble.onError = (errMsg) => {
      this.logTerminal(`[ERR] ${errMsg}`, 'error');
    };
  }

  handleIncomingRoverData(line) {
    // Parse Draw Execution Telemetry
    if (line.includes('DRAW:DONE') || line.includes('DRAW:STOPPED')) {
      if (this.isExecutingRoute) {
        this.advanceDrawQueue();
      }
    }

    // Parse Obstacle readings if received in format: "[DISTANCE FRONT] 35 cm"
    if (line.includes('[DISTANCE FRONT]')) {
      const match = line.match(/(\d+)\s*cm/);
      if (match && this.radarDistanceVal) {
        this.radarDistanceVal.textContent = match[1];
      }
    }

    // Parse IR Sensor logs if received in format: "[IR SENSORS] L:0 C:1 R:0"
    if (line.includes('[IR SENSORS]')) {
      const lMatch = line.includes('L:1');
      const cMatch = line.includes('C:1');
      const rMatch = line.includes('R:1');
      if (this.irLeft) this.irLeft.classList.toggle('active-line', lMatch);
      if (this.irCenter) this.irCenter.classList.toggle('active-line', cMatch);
      if (this.irRight) this.irRight.classList.toggle('active-line', rMatch);
    }
  }

  sendRoverCmd(command) {
    this.logTerminal(`[TX] ${command}`, 'tx');
    this.ble.send(command);
  }

  // ==========================================================================
  // MODE SWITCHING (M0, M1, M2, M3, M4)
  // ==========================================================================
  initModeNavigation() {
    this.modeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = parseInt(tab.getAttribute('data-mode'), 10);
        this.switchMode(mode);
      });
    });
  }

  switchMode(mode) {
    if (this.isExecutingRoute) {
      this.stopRouteExecution();
    }

    this.currentMode = mode;

    // Update Tab UI
    this.modeTabs.forEach(t => {
      const tMode = parseInt(t.getAttribute('data-mode'), 10);
      t.classList.toggle('active', tMode === mode);
    });

    // Update Panel Viewport
    this.modePanels.forEach((panel, idx) => {
      panel.classList.toggle('active', idx === mode);
    });

    // Send Mode Command to Arduino
    this.sendRoverCmd(`M${mode}`);

    // If switching to Draw Mode, trigger canvas resize to ensure crisp resolution
    if (mode === 3 && this.canvasHandler) {
      setTimeout(() => this.canvasHandler.resize(), 50);
    }
  }

  // ==========================================================================
  // SPEED CONTROL (0 to 9)
  // ==========================================================================
  initSpeedControls() {
    const updateSpeedUI = (val) => {
      this.currentSpeed = val;
      this.speedSlider.value = val;
      const pwm = SPEED_PWM_MAP[val];
      this.speedDisplay.textContent = `LVL ${val} // PWM ${pwm}`;
    };

    this.speedSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      updateSpeedUI(val);
      this.sendRoverCmd(val.toString());
    });

    this.btnSpeedDown.addEventListener('click', () => {
      if (this.currentSpeed > 0) {
        updateSpeedUI(this.currentSpeed - 1);
        this.sendRoverCmd(this.currentSpeed.toString());
      }
    });

    this.btnSpeedUp.addEventListener('click', () => {
      if (this.currentSpeed < 9) {
        updateSpeedUI(this.currentSpeed + 1);
        this.sendRoverCmd(this.currentSpeed.toString());
      }
    });
  }

  // ==========================================================================
  // DIRECTIONAL D-PAD (Press & Hold to drive, Release to stop)
  // ==========================================================================
  initDPadControls() {
    this.dpadButtons.forEach(btn => {
      const cmd = btn.getAttribute('data-cmd');

      // Center STOP button is tap-only
      if (cmd === 'S') {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.sendRoverCmd('S');
        });
        return;
      }

      // Touch events (Mobile phone)
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        this.sendRoverCmd(cmd);
      }, { passive: false });

      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        btn.classList.remove('pressed');
        this.sendRoverCmd('S');
      }, { passive: false });

      // Mouse events (Desktop testing)
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        this.sendRoverCmd(cmd);
      });

      btn.addEventListener('mouseup', (e) => {
        e.preventDefault();
        btn.classList.remove('pressed');
        this.sendRoverCmd('S');
      });

      btn.addEventListener('mouseleave', () => {
        if (btn.classList.contains('pressed')) {
          btn.classList.remove('pressed');
          this.sendRoverCmd('S');
        }
      });
    });
  }

  // Keyboard navigation for testing on PC
  initKeyboardControls() {
    const keyMap = {
      'ArrowUp': 'F', 'KeyW': 'F',
      'ArrowDown': 'B', 'KeyS': 'B',
      'ArrowLeft': 'L', 'KeyA': 'L',
      'ArrowRight': 'R', 'KeyD': 'R'
    };

    let activeKey = null;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.triggerEmergencyStop();
        return;
      }

      if (this.currentMode === 0 && keyMap[e.code] && activeKey !== e.code) {
        e.preventDefault();
        activeKey = e.code;
        const cmd = keyMap[e.code];
        this.sendRoverCmd(cmd);

        // Highlight button
        const btn = document.querySelector(`.dpad-btn[data-cmd="${cmd}"]`);
        if (btn) btn.classList.add('pressed');
      }
    });

    window.addEventListener('keyup', (e) => {
      if (activeKey === e.code) {
        activeKey = null;
        this.sendRoverCmd('S');
        this.dpadButtons.forEach(b => b.classList.remove('pressed'));
      }
    });
  }

  // ==========================================================================
  // DRAW-A-ROAD CANVAS & SEQUENCER
  // ==========================================================================
  initDrawCanvas() {
    const canvasElement = document.getElementById('road-canvas');
    if (!canvasElement) return;

    this.canvasHandler = new DrawCanvas(canvasElement, (commands) => {
      this.handleRouteGenerated(commands);
    });

    this.btnDrawClear.addEventListener('click', () => {
      this.stopRouteExecution();
      this.canvasHandler.clear();
      this.btnDrawSend.disabled = true;
      this.drawSummary.textContent = 'Draw path on canvas';
      this.routeStepsBox.style.display = 'none';
      this.routeStepsList.innerHTML = '';
    });

    this.btnDrawSend.addEventListener('click', () => {
      this.startRouteExecution();
    });
  }

  handleRouteGenerated(commands) {
    this.drawRoute = commands;
    if (!commands || commands.length === 0) {
      this.btnDrawSend.disabled = true;
      this.drawSummary.textContent = 'Draw path on canvas';
      this.routeStepsBox.style.display = 'none';
      return;
    }

    const totalTimeMs = commands.reduce((acc, c) => acc + (c.duration || 0), 0);
    this.drawSummary.textContent = `${commands.length - 1} steps (~${(totalTimeMs / 1000).toFixed(1)}s)`;
    this.btnDrawSend.disabled = false;

    // Render step list
    this.routeStepsList.innerHTML = '';
    commands.forEach((step, idx) => {
      const div = document.createElement('div');
      div.className = 'step-item';
      div.id = `step-item-${idx}`;
      div.innerHTML = `<span>#${idx + 1} ${step.label}</span><span>${step.cmd}</span>`;
      this.routeStepsList.appendChild(div);
    });
    this.routeStepsBox.style.display = 'block';
  }

  startRouteExecution() {
    if (!this.drawRoute || this.drawRoute.length === 0) return;

    this.isExecutingRoute = true;
    this.activeDrawStepIndex = 0;
    this.btnDrawSend.disabled = true;
    this.btnDrawSend.innerHTML = `<span>EXECUTING...</span>`;

    // Send mode M3 if not in draw mode
    this.sendRoverCmd('M3');

    // Send first command
    this.sendNextDrawCommand();
  }

  sendNextDrawCommand() {
    if (!this.isExecutingRoute) return;

    if (this.activeDrawStepIndex >= this.drawRoute.length) {
      this.stopRouteExecution();
      this.logTerminal('[DRAW] Entire route completed successfully!', 'rx');
      return;
    }

    // Highlight current executing step
    document.querySelectorAll('.step-item').forEach(el => el.classList.remove('executing'));
    const activeEl = document.getElementById(`step-item-${this.activeDrawStepIndex}`);
    if (activeEl) activeEl.classList.add('executing');

    const step = this.drawRoute[this.activeDrawStepIndex];
    this.sendRoverCmd(step.cmd);

    // Fallback timer: in case telemetry packet is missed over BLE
    const safetyTimeoutMs = (step.duration || 500) + 1200;
    clearTimeout(this.stepFallbackTimer);
    this.stepFallbackTimer = setTimeout(() => {
      if (this.isExecutingRoute) {
        this.advanceDrawQueue();
      }
    }, safetyTimeoutMs);
  }

  advanceDrawQueue() {
    clearTimeout(this.stepFallbackTimer);
    this.activeDrawStepIndex++;
    this.sendNextDrawCommand();
  }

  stopRouteExecution() {
    this.isExecutingRoute = false;
    clearTimeout(this.stepFallbackTimer);
    this.btnDrawSend.disabled = false;
    this.btnDrawSend.innerHTML = `<span>SEND ROUTE</span><span class="btn-arrow">➔</span>`;
    document.querySelectorAll('.step-item').forEach(el => el.classList.remove('executing'));
    this.sendRoverCmd('D:S');
  }

  // ==========================================================================
  // EMERGENCY STOP & TERMINAL
  // ==========================================================================
  initEmergencyStop() {
    this.btnEStop.addEventListener('click', () => {
      this.triggerEmergencyStop();
    });
  }

  triggerEmergencyStop() {
    this.stopRouteExecution();
    this.sendRoverCmd('M4');
    this.sendRoverCmd('S');
    this.logTerminal('[SAFETY] EMERGENCY STOP TRIGGERED!', 'error');

    // Haptic vibration feedback on phones supporting it
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }
  }

  initTerminal() {
    this.terminalToggle.addEventListener('click', () => {
      this.terminalDrawer.classList.toggle('open');
    });

    this.btnClearLogs.addEventListener('click', () => {
      this.terminalLogs.innerHTML = '';
      this.logTerminal('[SYSTEM] Console cleared.', 'system');
    });
  }

  logTerminal(text, type = 'system') {
    if (!this.terminalLogs) return;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `${time} ${text}`;
    this.terminalLogs.appendChild(line);
    this.terminalLogs.scrollTop = this.terminalLogs.scrollHeight;
  }

  // ==========================================================================
  // PROGRESSIVE WEB APP (PWA) INSTALLATION & SERVICE WORKER
  // ==========================================================================
  initPWA() {
    this.btnInstall = document.getElementById('btn-install');
    this.deferredPrompt = null;

    // Register Service Worker for offline performance and PWA compliance
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then((reg) => {
          console.log('[PWA] Service Worker registered with scope:', reg.scope);
        }).catch((err) => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });
      });
    }

    // Capture install prompt event (Chrome / Edge / Android)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      if (this.btnInstall) {
        this.btnInstall.style.display = 'flex';
      }
      this.logTerminal('[PWA] Ready to install! Tap INSTALL to add to home screen.', 'system');
    });

    if (this.btnInstall) {
      this.btnInstall.addEventListener('click', async () => {
        if (!this.deferredPrompt) return;
        this.btnInstall.style.display = 'none';
        this.deferredPrompt.prompt();
        const choice = await this.deferredPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          this.logTerminal('[PWA] Rover App successfully installed on device!', 'rx');
        }
        this.deferredPrompt = null;
      });
    }

    window.addEventListener('appinstalled', () => {
      if (this.btnInstall) {
        this.btnInstall.style.display = 'none';
      }
      this.logTerminal('[PWA] App installed as standalone application.', 'system');
    });
  }
}

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.roverApp = new RoverApp();
});
