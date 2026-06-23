import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type UseIdleCursorOptions = {
  enabled: boolean;
  targetRef: RefObject<HTMLElement>;
  delayMs?: number;
  shouldStayVisible?: () => boolean;
};

export function useIdleCursor({
  enabled,
  targetRef,
  delayMs = 2000,
  shouldStayVisible,
}: UseIdleCursorOptions) {
  const [isCursorHidden, setIsCursorHidden] = useState(false);
  const isCursorHiddenRef = useRef(false);
  const cursorTimerRef = useRef<number | null>(null);
  const shouldStayVisibleRef = useRef(shouldStayVisible);

  useEffect(() => {
    shouldStayVisibleRef.current = shouldStayVisible;
  }, [shouldStayVisible]);

  const clearCursorTimer = useCallback(() => {
    if (cursorTimerRef.current !== null) {
      window.clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
  }, []);

  const setCursorHidden = useCallback((hidden: boolean) => {
    if (isCursorHiddenRef.current === hidden) return;
    isCursorHiddenRef.current = hidden;
    setIsCursorHidden(hidden);
  }, []);

  const shouldPauseTimer = useCallback(() => {
    if (typeof window !== 'undefined') {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return true;
    }
    return shouldStayVisibleRef.current?.() ?? false;
  }, []);

  const showCursorAndRestartTimer = useCallback(() => {
    clearCursorTimer();
    setCursorHidden(false);

    if (!enabled || shouldPauseTimer()) return;

    cursorTimerRef.current = window.setTimeout(() => {
      if (shouldPauseTimer()) return;
      setCursorHidden(true);
    }, delayMs);
  }, [clearCursorTimer, delayMs, enabled, setCursorHidden, shouldPauseTimer]);

  const pauseCursorHide = useCallback(() => {
    clearCursorTimer();
    setCursorHidden(false);
  }, [clearCursorTimer, setCursorHidden]);

  useEffect(() => {
    if (!enabled) {
      pauseCursorHide();
      return;
    }

    showCursorAndRestartTimer();
    return clearCursorTimer;
  }, [clearCursorTimer, enabled, pauseCursorHide, showCursorAndRestartTimer]);

  useEffect(() => {
    const target = targetRef.current;
    if (!enabled || !target) return;

    const handleActivity = () => showCursorAndRestartTimer();
    const handlePress = () => pauseCursorHide();
    const handleRelease = () => showCursorAndRestartTimer();

    target.addEventListener('mousemove', handleActivity, { passive: true });
    target.addEventListener('pointermove', handleActivity, { passive: true });
    target.addEventListener('mouseenter', handleActivity, { passive: true });
    target.addEventListener('pointerenter', handleActivity, { passive: true });
    target.addEventListener('mousedown', handlePress, { passive: true });
    target.addEventListener('pointerdown', handlePress, { passive: true });
    target.addEventListener('mouseup', handleRelease, { passive: true });
    target.addEventListener('pointerup', handleRelease, { passive: true });

    return () => {
      target.removeEventListener('mousemove', handleActivity);
      target.removeEventListener('pointermove', handleActivity);
      target.removeEventListener('mouseenter', handleActivity);
      target.removeEventListener('pointerenter', handleActivity);
      target.removeEventListener('mousedown', handlePress);
      target.removeEventListener('pointerdown', handlePress);
      target.removeEventListener('mouseup', handleRelease);
      target.removeEventListener('pointerup', handleRelease);
    };
  }, [enabled, pauseCursorHide, showCursorAndRestartTimer, targetRef]);

  useEffect(() => clearCursorTimer, [clearCursorTimer]);

  return {
    isCursorHidden,
    pauseCursorHide,
    showCursorAndRestartTimer,
  };
}
