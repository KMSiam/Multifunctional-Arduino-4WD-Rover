/**
 * Bluetooth Manager for HM-10 BLE Module using Web Bluetooth API
 * Service UUID: 0000ffe0-0000-1000-8000-00805f9b34fb
 * Characteristic UUID: 0000ffe1-0000-1000-8000-00805f9b34fb
 */

export class RoverBluetooth {
  constructor() {
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.isConnected = false;

    // Callbacks
    this.onStatusChange = () => {};
    this.onDataReceived = () => {};
    this.onError = () => {};

    // Standard HM-10 Serial GATT UUIDs
    this.SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
    this.CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.incomingBuffer = '';
  }

  /**
   * Check if Web Bluetooth API is supported by the browser
   */
  isSupported() {
    return (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
  }

  /**
   * Request and connect to HM-10 BLE device
   */
  async connect() {
    if (!this.isSupported()) {
      throw new Error('Web Bluetooth is not supported in this browser. Please use Chrome on Android, Windows, or Mac.');
    }

    try {
      this.onStatusChange('connecting', 'Searching for Rover...');

      // Request Bluetooth device with HM-10 service or by name prefix
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [this.SERVICE_UUID] },
          { namePrefix: 'HM' },
          { namePrefix: 'BT' },
          { namePrefix: 'MLT' },
          { namePrefix: 'DSD' },
          { namePrefix: 'Rover' }
        ],
        optionalServices: [this.SERVICE_UUID]
      });

      this.device.addEventListener('gattserverdisconnected', () => {
        this.handleDisconnect();
      });

      this.onStatusChange('connecting', `Connecting to ${this.device.name || 'Rover'}...`);

      // Connect to GATT Server
      this.server = await this.device.gatt.connect();

      // Get Serial Service
      const service = await this.server.getPrimaryService(this.SERVICE_UUID);

      // Get Serial Characteristic
      this.characteristic = await service.getCharacteristic(this.CHARACTERISTIC_UUID);

      // Start notifications for incoming telemetry from Arduino
      await this.characteristic.startNotifications();
      this.characteristic.addEventListener('characteristicvaluechanged', (event) => {
        this.handleIncomingData(event);
      });

      this.isConnected = true;
      this.onStatusChange('connected', this.device.name || 'Rover Connected');
      return true;
    } catch (err) {
      this.handleDisconnect();
      if (err.name !== 'NotFoundError') { // User didn't just cancel picker
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
    this.characteristic = null;
    this.onStatusChange('disconnected', 'Disconnected');
  }

  /**
   * Handle incoming stream from Arduino
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
    if (!this.isConnected || !this.characteristic) {
      console.warn('Cannot send command - Bluetooth not connected:', command);
      return false;
    }

    try {
      const data = this.encoder.encode(command + '\n');
      // Use writeValueWithResponse or writeValueWithoutResponse
      if (this.characteristic.writeValueWithoutResponse) {
        await this.characteristic.writeValueWithoutResponse(data);
      } else {
        await this.characteristic.writeValue(data);
      }
      return true;
    } catch (err) {
      console.error('Failed to send BLE command:', err);
      this.onError('Send error: ' + err.message);
      return false;
    }
  }
}
