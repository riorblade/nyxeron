import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Avatar } from "@nyxeron/core";
import { cn } from "@/lib/utils";
import { avatarMaterial, buildRig, type Rig } from "./rig";
import { applyMove, DANCES, isCelebration, type Move } from "./moves";
import { Showers } from "./showers";

/**
 * One avatar dancing on a small neon stage (wardrobe, dashboard). Drag to turn it. `move` "auto" cycles the dances.
 * Each preview owns a WebGL context, so keep one or two on screen at a time.
 */
export function AvatarPreview({
  look,
  move = "auto",
  className,
}: {
  look: Avatar;
  move?: Move | "auto";
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ setLook(a: Avatar): void; move: Move | "auto" } | null>(
    null,
  );

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    camera.position.set(0, 0.7, 3.6);
    camera.lookAt(0, 0.6, 0);
    scene.add(new THREE.HemisphereLight("#d9ccff", "#2a1350", 1.6));
    const key = new THREE.DirectionalLight("#ffffff", 1.4);
    key.position.set(1.5, 3, 2.5);
    scene.add(key);
    const rim = new THREE.PointLight("#ff2bd6", 3, 6);
    rim.position.set(-1.2, 1.2, -1);
    scene.add(rim);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 40),
      new THREE.MeshBasicMaterial({
        color: "#8b5cf6",
        transparent: true,
        opacity: 0.25,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    scene.add(disc);
    const showers = new Showers(scene);
    const mat = avatarMaterial(0.25);
    let rig: Rig | null = null;
    let turn = 0.4;
    const setLook = (a: Avatar) => {
      if (rig) {
        scene.remove(rig.mesh);
        rig.dispose();
      }
      rig = buildRig(a);
      rig.mesh.material = mat;
      rig.mesh.scale.setScalar(1.1);
      scene.add(rig.mesh);
    };
    api.current = { setLook, move: "auto" };
    setLook(look);

    const size = () => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();

    let drag: number | null = null;
    const down = (e: PointerEvent) => (drag = e.clientX);
    const moveP = (e: PointerEvent) => {
      if (drag === null) return;
      turn += (e.clientX - drag) * 0.01;
      drag = e.clientX;
    };
    const up = () => (drag = null);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", moveP);
    window.addEventListener("pointerup", up);

    let last = performance.now();
    renderer.setAnimationLoop((now) => {
      const dt = now - last;
      last = now;
      const b = (now / 60000) * 118;
      const m = api.current!.move;
      const current: Move =
        m === "auto" ? DANCES[Math.floor(b / 8) % DANCES.length]! : m;
      if (rig) {
        applyMove(rig, current, b, 0.8);
        if (isCelebration(current)) showers.emit(rig, current, b);
        if (drag === null) turn += 0.004;
        rig.mesh.rotation.y = Math.sin(turn) * 0.9;
      }
      showers.update(dt);
      renderer.render(scene, camera);
    });
    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", moveP);
      window.removeEventListener("pointerup", up);
      rig?.dispose();
      showers.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    // ponytail: built once; look and move flow in through api below, so the WebGL context is never recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => api.current?.setLook(look), [look]);
  useEffect(() => {
    if (api.current) api.current.move = move;
  }, [move]);

  return (
    <div
      ref={host}
      className={cn("cursor-grab touch-none active:cursor-grabbing", className)}
    />
  );
}
