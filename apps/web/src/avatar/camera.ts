// The guest's cameras: through their own eyes, over their shoulder, or the drone (the club's orbit camera, which
// the scene runs itself). Drag (mouse or the right half of a touch screen) turns the view.
import * as THREE from "three";

export type CamMode = "eyes" | "behind" | "drone";
export const CAM_MODES: CamMode[] = ["behind", "eyes", "drone"];

export class GuestCamera {
  /** Where the view looks (radians; 0 = +z) and how far up/down. */
  yaw = 0;
  pitch = -0.18;
  private drag: { id: number; x: number; y: number } | null = null;
  private off: (() => void)[] = [];

  /** Turn the view by dragging on `el` (pointers that start on the left third of a touch screen belong to the stick). */
  bind(el: HTMLElement, enabled: () => boolean) {
    const down = (e: PointerEvent) => {
      if (!enabled()) return;
      if (e.pointerType === "touch" && e.clientX < innerWidth / 3) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const k = e.pointerType === "touch" ? 0.006 : 0.004;
      this.yaw -= (e.clientX - this.drag.x) * k;
      this.pitch = Math.max(
        -1.2,
        Math.min(0.9, this.pitch - (e.clientY - this.drag.y) * k),
      );
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    this.off.push(() => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    });
  }

  /** Places `cam` for the avatar standing at `at` with height `h` (eyes / behind; drone is the orbit camera). */
  place(
    cam: THREE.PerspectiveCamera,
    mode: CamMode,
    at: THREE.Vector3,
    h: number,
    dt: number,
  ) {
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    if (mode === "eyes") {
      cam.position.set(at.x, at.y + h * 0.9, at.z).addScaledVector(dir, 0.06);
      cam.lookAt(cam.position.clone().add(dir));
      return;
    }
    // Over the shoulder: behind and above, eased so the turn feels smooth.
    const want = at
      .clone()
      .add(new THREE.Vector3(0, h * 1.25, 0))
      .addScaledVector(dir, -2.4);
    want.y = Math.max(0.35, want.y);
    cam.position.lerp(want, Math.min(1, dt / 90));
    cam.lookAt(at.x, at.y + h * 0.85, at.z);
  }

  dispose() {
    this.off.forEach((f) => f());
    this.off = [];
  }
}
