"use client";

import { useEffect, useState } from "react";

// 夜间主题时段：访客本地时间 18:00 起至次日 05:00（含 18:00，不含 05:00）
export const NIGHT_START_HOUR = 18;
export const NIGHT_END_HOUR = 5;

const CHECK_INTERVAL_MS = 30_000;

export function isNightTime(
  date: Date,
  startHour = NIGHT_START_HOUR,
  endHour = NIGHT_END_HOUR,
): boolean {
  const hour = date.getHours();
  if (startHour === endHour) return false;
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

// 跨午夜区间无法用一次 setTimeout 精确对齐时，用 30s 轮询兜底：
// 同时能覆盖系统休眠唤醒、手动改时间等情况，状态不变时 setState 会被 React 跳过。
export function useNightMode(): boolean {
  const [isNight, setIsNight] = useState(() => isNightTime(new Date()));

  useEffect(() => {
    const update = () => setIsNight(isNightTime(new Date()));
    update();
    const timer = window.setInterval(update, CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("night-mode", isNight);
    return () => {
      document.body.classList.remove("night-mode");
    };
  }, [isNight]);

  return isNight;
}

export default useNightMode;
