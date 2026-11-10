"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchCurrent,
  fetchTimeline,
  type DashboardRequestOptions,
  type CurrentResponse,
  type TimelineResponse,
} from "@/lib/api";

const POLL_INTERVAL = 10 * 1000; // 10 seconds
const REQUEST_TIMEOUT = 8 * 1000;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function useDashboard(dashboardId?: string) {
  const [current, setCurrent] = useState<CurrentResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const firstLoad = useRef(true);
  const requestOptions = useMemo<DashboardRequestOptions | undefined>(() => {
    return dashboardId ? { dashboardId } : undefined;
  }, [dashboardId]);

  useEffect(() => {
    if (!selectedDate) setSelectedDate(todayStr());
  }, [selectedDate]);

  useEffect(() => {
    if (!selectedDate) return;

    const controller = new AbortController();
    let requestId = 0;

    const doFetch = async () => {
      const thisRequest = ++requestId;
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, REQUEST_TIMEOUT);
      controller.signal.addEventListener("abort", abortRequest, { once: true });

      try {
        if (firstLoad.current) setLoading(true);
        const [cur, tl] = await Promise.all([
          fetchCurrent(requestController.signal, requestOptions),
          fetchTimeline(selectedDate, requestController.signal, requestOptions),
        ]);
        if (!controller.signal.aborted && thisRequest === requestId) {
          setCurrent(cur);
          setTimeline(tl);
          setViewerCount(cur.viewer_count ?? 0);
          setError(null);
        }
      } catch (e) {
        requestController.abort();
        if (!controller.signal.aborted && thisRequest === requestId) {
          setError(
            timedOut
              ? "请求超时，请检查服务器连接"
              : e instanceof Error
                ? e.message
                : "Failed to fetch data",
          );
        }
      } finally {
        window.clearTimeout(timeoutId);
        controller.signal.removeEventListener("abort", abortRequest);
        if (!controller.signal.aborted && thisRequest === requestId) {
          setLoading(false);
          firstLoad.current = false;
        }
      }
    };

    firstLoad.current = true;
    doFetch();
    const pollId = setInterval(doFetch, POLL_INTERVAL);

    return () => {
      controller.abort();
      clearInterval(pollId);
    };
  }, [requestOptions, selectedDate]);

  const changeDate = useCallback((date: string) => {
    setSelectedDate(date);
  }, []);

  return { current, timeline, selectedDate, changeDate, loading, error, viewerCount };
}
