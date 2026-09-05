/**
 * Universal Bluetooth Manager for Arduino Rover BLE Modules
 * Supports:
 *   1. Standard HM-10 / CC2541 / BT05 / AT-09 (UUID 0xFFE0 / 0xFFE1)
 *   2. Nordic UART Service / ESP32 / BLE 5.0 (UUID 6E400001 / 6E400002 / 6E400003)
 */

export class RoverBluetooth {
  constructor() {
    this.device = null;
    this.server = null;
    this.txCharacteristic = null; // For sending commands to Arduino
    this.rxCharacteristic = null; // For receiving telemetry from Arduino
    this.isConnected = false;

    // Callbacks
    this.onStatusChange = () => {};
    this.onDataReceived = () => {};
    this.onError = () => {};

    // Standard HM-10 Serial GATT UUIDs
    this.HM10_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
    this.HM10_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';

    // Nordic UART Service (NUS) UUIDs
    this.NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    this.NUS_RX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Phone TX -> Rover RX
    this.NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Rover TX -> Phone RX

    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.incomingBuffer = '';
  }

  /**
   * Check if Web Bluetooth API is supported by current browser
   */
  isSupported() {
    return (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
  }

  /**
   * Request and connect to BLE device
   */
  async connect() {
    if (!this.isSupported()) {
      throw new Error('Web Bluetooth is not supported in this browser. Please use Chrome on Android, Windows, or Mac.');
    }

    try {
      this.onStatusChange('connecting', 'Searching for Rover...');

      // Accept all devices to support any clone (HM-10, AT-09, BT05, JDY, etc.)
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [this.HM10_SERVICE, this.NUS_SERVICE]
      });

      this.device.addEventListener('gattserverdisconnected', () => {
        this.handleDisconnect();
      });

      this.onStatusChange('connecting', `Connecting to ${this.device.name || 'Rover'}...`);

      // Connect to GATT Server
      this.server = await this.device.gatt.connect();

      // Try HM-10 Service first
      let service = null;
      try {
        service = await this.server.getPrimaryService(this.HM10_SERVICE);
        const char = await service.getCharacteristic(this.HM10_CHAR);
        this.txCharacteristic = char;
        this.rxCharacteristic = char;
      } catch {
        // Fallback to Nordic UART Service
        service = await this.server.getPrimaryService(this.NUS_SERVICE);
        this.txCharacteristic = await service.getCharacteristic(this.NUS_RX_CHAR);
        this.rxCharacteristic = await service.getCharacteristic(this.NUS_TX_CHAR);
      }

      // Start notifications for incoming telemetry from Arduino
      if (this.rxCharacteristic) {
        await this.rxCharacteristic.startNotifications();
        this.rxCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
          this.handleIncomingData(event);
        });
      }

      this.isConnected = true;
      this.onStatusChange('connected', this.device.name || 'Rover Connected');
      return true;
    } catch (err) {
      this.handleDisconnect();
      if (err.name !== 'NotFoundError') { // User didn't just dismiss picker
        this.onError(err.message || 'Bluetooth connection failed');
      }
      throw err;
    }
  }

  /**
   * Disconnect from Rover
   */
  disconnect() {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.handleDisconnect();
  }

  handleDisconnect() {
    this.isConnected = false;
    this.server = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.onStatusChange('disconnected', 'Disconnected');
  }

  /**
   * Handle incoming data stream from Arduino
   */
  handleIncomingData(event) {
    const value = event.target.value;
    const textChunk = this.decoder.decode(value);
    this.incomingBuffer += textChunk;

    // Process complete newline-separated lines
    const lines = this.incomingBuffer.split(/[\r\n]+/);
    if (lines.length > 1) {
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line.length > 0) {
          this.onDataReceived(line);
        }
      }
      this.incomingBuffer = lines[lines.length - 1]; // Keep incomplete remainder
    }
  }

  /**
   * Send text command to Arduino via BLE
   * Automatically appends newline '\n'
   */
  async send(command) {
    if (!this.isConnected || !this.txCharacteristic) {
      console.warn('Cannot send command - Bluetooth not connected:', command);
      return false;
    }

    try {
      const data = this.encoder.encode(command + '\n');
      if (this.txCharacteristic.writeValueWithoutResponse) {
        await this.txCharacteristic.writeValueWithoutResponse(data);
      } else {
        await this.txCharacteristic.writeValue(data);
      }
      return true;
    } catch (err) {
      console.error('Failed to send BLE command:', err);
      this.onError('Send error: ' + err.message);
      return false;
    }
  }
}
