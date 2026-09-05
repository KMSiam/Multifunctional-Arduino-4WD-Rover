/**
 * Draw-a-Road Canvas & Vector Path Analyzer
 * Captures user finger/touch drawing and converts it into timed Arduino D: commands
 */

export class DrawCanvas {
  constructor(canvasElement, onRouteGenerated) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.onRouteGenerated = onRouteGenerated;

    this.points = [];
    this.isDrawing = false;
    this.generatedCommands = [];

    // Colors (strictly no blues!)
    this.GRID_COLOR = '#1f242c';
    this.PATH_COLOR = '#f59e0b';       // Solar Amber
    this.START_COLOR = '#10b981';      // Emerald Start Node
    this.END_COLOR = '#ef4444';        // Crimson End Node

    this.setupEvents();
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.redraw();
  }

  setupEvents() {
    window.addEventListener('resize', () => this.resize());

    // Touch events for mobile phones
    this.canvas.addEventListener('touchstart', (e) => this.startDraw(e), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this.moveDraw(e), { passive: false });
    this.canvas.addEventListener('touchend', (e) => this.endDraw(e), { passive: false });

    // Mouse events for desktop
    this.canvas.addEventListener('mousedown', (e) => this.startDraw(e));
    this.canvas.addEventListener('mousemove', (e) => this.moveDraw(e));
    this.canvas.addEventListener('mouseup', (e) => this.endDraw(e));
    this.canvas.addEventListener('mouseleave', (e) => {
      if (this.isDrawing) this.endDraw(e);
    });
    window.addEventListener('mouseup', (e) => {
      if (this.isDrawing) this.endDraw(e);
    });
  }

  getPointerPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  startDraw(e) {
    e.preventDefault();
    this.isDrawing = true;
    this.points = [];
    this.generatedCommands = [];
    const pos = this.getPointerPos(e);
    this.points.push(pos);
    this.redraw();
  }

  moveDraw(e) {
    if (!this.isDrawing) return;
    e.preventDefault();
    const pos = this.getPointerPos(e);

    // Minimum distance threshold between points to avoid jitter
    const last = this.points[this.points.length - 1];
    const dist = Math.hypot(pos.x - last.x, pos.y - last.y);
    if (dist > 8) {
      this.points.push(pos);
      this.redraw();
    }
  }

  endDraw(e) {
    if (!this.isDrawing) return;
    e.preventDefault();
    this.isDrawing = false;

    if (this.points.length > 2) {
      this.analyzeAndConvertRoute();
    }
    this.redraw();
  }

  clear() {
    this.points = [];
    this.generatedCommands = [];
    this.redraw();
    if (this.onRouteGenerated) {
      this.onRouteGenerated([]);
    }
  }

  redraw() {
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Draw minimalist dot grid
    this.drawGrid();

    if (this.points.length === 0) {
      // Draw friendly prompt
      this.ctx.fillStyle = '#6b7280';
      this.ctx.font = '13px system-ui, sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('Draw route here with your finger 👆', this.width / 2, this.height / 2);
      return;
    }

    // Draw active path
    this.ctx.strokeStyle = this.PATH_COLOR;
    this.ctx.lineWidth = 4;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.shadowColor = 'rgba(245, 158, 11, 0.4)';
    this.ctx.shadowBlur = 10;

    this.ctx.beginPath();
    this.ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      this.ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    this.ctx.stroke();
    this.ctx.shadowBlur = 0; // Reset

    // Draw Start Node
    const start = this.points[0];
    this.ctx.fillStyle = this.START_COLOR;
    this.ctx.beginPath();
    this.ctx.arc(start.x, start.y, 7, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw End Node
    const end = this.points[this.points.length - 1];
    this.ctx.fillStyle = this.END_COLOR;
    this.ctx.beginPath();
    this.ctx.arc(end.x, end.y, 6, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawGrid() {
    const step = 25;
    this.ctx.fillStyle = this.GRID_COLOR;
    for (let x = step / 2; x < this.width; x += step) {
      for (let y = step / 2; y < this.height; y += step) {
        this.ctx.fillRect(x, y, 1.5, 1.5);
      }
    }
  }

  /**
   * Simplifies touch path into straight forward motions and left/right turns.
   * Calibration:
   *   - 100px straight distance ≈ 800ms forward drive
   *   - 90-degree turn ≈ 450ms pivot turn
   */
  analyzeAndConvertRoute() {
    if (this.points.length < 2) return;

    // 1. Simplify points using distance downsampling
    const simplified = [this.points[0]];
    for (let i = 1; i < this.points.length; i++) {
      const p = this.points[i];
      const last = simplified[simplified.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 30) {
        simplified.push(p);
      }
    }
    if (simplified[simplified.length - 1] !== this.points[this.points.length - 1]) {
      simplified.push(this.points[this.points.length - 1]);
    }

    if (simplified.length < 2) return;

    const commands = [];
    // Initial heading is facing North/Up (-90 degrees in canvas coords)
    let currentHeading = -Math.PI / 2;

    for (let i = 0; i < simplified.length - 1; i++) {
      const p1 = simplified[i];
      const p2 = simplified[i + 1];

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const distancePx = Math.hypot(dx, dy);
      const targetAngle = Math.atan2(dy, dx);

      // Angle difference between current rover heading and target direction
      let angleDiff = targetAngle - currentHeading;
      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

      // Degrees of turn required
      const degrees = (angleDiff * 180) / Math.PI;

      // If angle change is significant (> 25 degrees), add turn command
      if (Math.abs(degrees) >= 25) {
        const turnDir = degrees > 0 ? 'R' : 'L';
        // 90 deg ~ 450 ms (clamp between 200ms and 1200ms)
        const turnDuration = Math.round(Math.min(1200, Math.max(200, (Math.abs(degrees) / 90) * 450)));
        commands.push({
          type: 'TURN',
          cmd: `D:${turnDir}:${turnDuration}`,
          label: `Turn ${turnDir === 'L' ? 'Left' : 'Right'} ${Math.round(Math.abs(degrees))}° (${turnDuration}ms)`,
          duration: turnDuration
        });
        currentHeading = targetAngle;
      }

      // Add forward drive for the segment length
      // 100px ~ 800ms
      const fwdDuration = Math.round(Math.min(4000, Math.max(300, distancePx * 8)));
      commands.push({
        type: 'MOVE',
        cmd: `D:F:${fwdDuration}`,
        label: `Forward ${Math.round(distancePx)}px (${fwdDuration}ms)`,
        duration: fwdDuration
      });
    }

    // Append Stop command at end of route
    commands.push({
      type: 'STOP',
      cmd: 'D:S',
      label: 'Stop at destination',
      duration: 0
    });

    this.generatedCommands = commands;

    if (this.onRouteGenerated) {
      this.onRouteGenerated(commands);
    }
  }
}
