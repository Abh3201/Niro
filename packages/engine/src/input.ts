import { type Camera, panBy, screenToWorld, wheelZoomFactor, zoomAt } from "./camera";
import type { Point, Viewport } from "./geometry";
import { pinchCamera } from "./gestures";
import type { ToolPointer } from "./interaction";

/** What the input controller needs from the engine. */
export interface InputHost {
  readonly container: HTMLElement;
  getCamera(): Camera;
  setCamera(camera: Camera): void;
  getViewport(): Viewport;
  zoomStep(direction: 1 | -1): void;
  resetZoom(): void;
  /** True when dragging with the primary button pans (the hand tool). */
  primaryDragPans(): boolean;
  /** Offers a primary-button press to the active tool. False means "not mine": it pans. */
  toolDown(pointer: ToolPointer): boolean;
  toolMove(pointer: ToolPointer): void;
  toolUp(pointer: ToolPointer): void;
  /** The pointer moved with no button down. */
  toolHover(pointer: ToolPointer): void;
  /** A second finger, a lost pointer or a lost window focus interrupted the tool. */
  toolCancel(): void;
  /** Editing shortcuts. Returns true when the key was handled. */
  keyDown(event: KeyboardEvent): boolean;
  /** Cursor the active tool wants when no pan is happening. */
  toolCursor(): string;
}

/** Safari's non-standard trackpad pinch event. */
interface GestureEvent extends UIEvent {
  readonly scale: number;
}

/**
 * Turns pointer, wheel, gesture and keyboard events into camera movement, and
 * hands the rest to the active tool.
 *
 * - Wheel or two-finger trackpad scroll pans; ctrl/cmd + wheel and trackpad
 *   pinch (which browsers report as ctrl + wheel) zoom at the cursor.
 * - Space + drag, middle-button drag, or the hand tool pan.
 * - Two fingers on a touch screen pinch-zoom and pan at the same time.
 * - Ctrl/cmd + "=", "-" and "0" zoom in, out and back to 100%.
 * - Any other primary-button press goes to the tool, which may decline it
 *   (one finger on empty space pans on a touch screen).
 */
export class InputController {
  private readonly pointers = new Map<number, Point>();
  private pan: { pointerId: number; last: Point } | null = null;
  /** The pointer the active tool is tracking, if any. */
  private toolPointer: number | null = null;
  private pinch: [number, number] | null = null;
  private gestureStartZoom: number | null = null;
  private spaceDown = false;
  private lastPointer: Point | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly host: InputHost) {
    const el = host.container;
    this.listen(el, "pointerdown", this.onPointerDown);
    this.listen(el, "pointermove", this.onPointerMove);
    this.listen(el, "pointerup", this.onPointerEnd);
    this.listen(el, "pointercancel", this.onPointerEnd);
    this.listen(el, "wheel", this.onWheel, { passive: false });
    this.listen(el, "gesturestart", this.onGestureStart);
    this.listen(el, "gesturechange", this.onGestureChange);
    this.listen(el, "gestureend", this.onGestureEnd);
    this.listen(window, "keydown", this.onKeyDown);
    this.listen(window, "keyup", this.onKeyUp);
    this.listen(window, "blur", this.onBlur);
    this.updateCursor();
  }

  destroy(): void {
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
  }

  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void,
    options?: AddEventListenerOptions,
  ): void {
    const bound = handler.bind(this) as EventListener;
    target.addEventListener(type, bound, options);
    this.cleanup.push(() => target.removeEventListener(type, bound, options));
  }

  private local(event: { clientX: number; clientY: number }): Point {
    const rect = this.host.container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private toolPointerFrom(event: PointerEvent, screen: Point): ToolPointer {
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      screen,
      world: screenToWorld(this.host.getCamera(), screen),
      shiftKey: event.shiftKey,
    };
  }

  /** Re-reads the cursor, for when the tool's hover target changed. */
  refreshCursor(): void {
    this.updateCursor();
  }

  private onPointerDown(event: PointerEvent): void {
    const point = this.local(event);
    this.pointers.set(event.pointerId, point);
    this.lastPointer = point;

    const touches = [...this.pointers.keys()].filter((id) => id !== event.pointerId);
    if (event.pointerType === "touch" && touches.length >= 1 && touches[0] !== undefined) {
      // A second finger turns any pan or tool gesture into a pinch.
      this.pinch = [touches[0], event.pointerId];
      this.pan = null;
      if (this.toolPointer !== null) {
        this.toolPointer = null;
        this.host.toolCancel();
      }
      return;
    }

    const wantsPan =
      event.button === 1 || (event.button === 0 && (this.spaceDown || this.host.primaryDragPans()));
    if (wantsPan) {
      event.preventDefault(); // no middle-click autoscroll
      this.startPan(event.pointerId, point);
      return;
    }
    if (event.button !== 0) return;

    if (this.host.toolDown(this.toolPointerFrom(event, point))) {
      this.toolPointer = event.pointerId;
      this.host.container.setPointerCapture?.(event.pointerId);
      this.updateCursor();
    } else {
      this.startPan(event.pointerId, point);
    }
  }

  private startPan(pointerId: number, point: Point): void {
    this.pan = { pointerId, last: point };
    this.host.container.setPointerCapture?.(pointerId);
    this.updateCursor();
  }

  private onPointerMove(event: PointerEvent): void {
    const point = this.local(event);
    this.lastPointer = point;
    const previous = this.pointers.get(event.pointerId);
    if (!previous) {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        this.host.toolHover(this.toolPointerFrom(event, point));
        this.updateCursor();
      }
      return;
    }

    if (this.pinch?.includes(event.pointerId)) {
      const [a, b] = this.pinch;
      const before = [this.pointers.get(a), this.pointers.get(b)] as const;
      this.pointers.set(event.pointerId, point);
      const after = [this.pointers.get(a), this.pointers.get(b)] as const;
      if (before[0] && before[1] && after[0] && after[1]) {
        const camera = pinchCamera(
          this.host.getCamera(),
          [before[0], before[1]],
          [after[0], after[1]],
        );
        this.host.setCamera(camera);
      }
      return;
    }

    this.pointers.set(event.pointerId, point);
    if (this.pan?.pointerId === event.pointerId) {
      const { last } = this.pan;
      this.host.setCamera(panBy(this.host.getCamera(), point.x - last.x, point.y - last.y));
      this.pan.last = point;
    } else if (this.toolPointer === event.pointerId) {
      this.host.toolMove(this.toolPointerFrom(event, point));
      this.updateCursor();
    }
  }

  private onPointerEnd(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);

    if (this.toolPointer === event.pointerId) {
      this.toolPointer = null;
      if (event.type === "pointercancel") this.host.toolCancel();
      else this.host.toolUp(this.toolPointerFrom(event, this.local(event)));
    }

    if (this.pinch?.includes(event.pointerId)) {
      // Lifting one finger of a pinch continues as a one-finger pan.
      const remaining = this.pinch.find((id) => id !== event.pointerId);
      const point = remaining === undefined ? undefined : this.pointers.get(remaining);
      this.pinch = null;
      if (remaining !== undefined && point) this.pan = { pointerId: remaining, last: point };
    }
    if (this.pan?.pointerId === event.pointerId) this.pan = null;
    this.updateCursor();
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault(); // stops page zoom, scroll bounce and swipe-to-go-back
    const camera = this.host.getCamera();
    const point = this.local(event);
    this.lastPointer = point;

    if (event.ctrlKey || event.metaKey) {
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
      this.host.setCamera(zoomAt(camera, point, camera.zoom * factor));
      return;
    }

    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    let dx = event.deltaX * unit;
    let dy = event.deltaY * unit;
    if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0]; // shift + mouse wheel scrolls sideways
    this.host.setCamera(panBy(camera, -dx, -dy));
  }

  private onGestureStart(event: GestureEvent): void {
    event.preventDefault();
    this.gestureStartZoom = this.host.getCamera().zoom;
  }

  private onGestureChange(event: GestureEvent): void {
    event.preventDefault();
    if (this.gestureStartZoom === null) return;
    const viewport = this.host.getViewport();
    const anchor = this.lastPointer ?? { x: viewport.width / 2, y: viewport.height / 2 };
    const camera = this.host.getCamera();
    this.host.setCamera(zoomAt(camera, anchor, this.gestureStartZoom * event.scale));
  }

  private onGestureEnd(event: GestureEvent): void {
    event.preventDefault();
    this.gestureStartZoom = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (isEditable(event.target)) return;

    // Space on a focused button presses it; only take it over on the board itself.
    if (event.code === "Space" && !isButton(event.target)) {
      event.preventDefault(); // no page scroll
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.updateCursor();
      }
      return;
    }

    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      this.host.zoomStep(1);
    } else if (mod && event.key === "-") {
      event.preventDefault();
      this.host.zoomStep(-1);
    } else if (mod && event.key === "0") {
      event.preventDefault();
      this.host.resetZoom();
    } else if (this.host.keyDown(event)) {
      event.preventDefault();
      this.updateCursor();
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (event.code === "Space") {
      this.spaceDown = false;
      this.updateCursor();
    }
  }

  private onBlur(): void {
    this.spaceDown = false;
    this.pan = null;
    this.pinch = null;
    this.pointers.clear();
    if (this.toolPointer !== null) {
      this.toolPointer = null;
      this.host.toolCancel();
    }
    this.updateCursor();
  }

  private updateCursor(): void {
    const style = this.host.container.style;
    if (this.pan) style.cursor = "grabbing";
    else if (this.toolPointer === null && (this.spaceDown || this.host.primaryDragPans()))
      style.cursor = "grab";
    else style.cursor = this.host.toolCursor();
  }
}

function isButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("button, a[href]") !== null;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
