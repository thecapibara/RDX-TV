import { useEffect } from "react";
import { playHoverSound, playButtonClickSound, playBackSound } from "../services/sound";

export const TV_BACK_EVENT = "rdx-tv-back";

const isTextInput = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
};

const isVisible = (el: HTMLElement): boolean => {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
};

const getActiveScope = (): ParentNode => {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>('[data-tv-scope="modal"]')
  ).filter(isVisible);
  if (modals.length > 0) {
    return modals[modals.length - 1];
  }
  return document;
};

const getFocusableElements = (scope: ParentNode): HTMLElement[] => {
  return Array.from(
    scope.querySelectorAll<HTMLElement>("[data-tv-focusable]")
  ).filter(isVisible);
};

export function focusFirstInScope(scope?: ParentNode) {
  const targetScope = scope || getActiveScope();
  const auto = targetScope.querySelector<HTMLElement>("[data-tv-autofocus]");
  if (auto && isVisible(auto)) {
    auto.focus({ preventScroll: true });
    auto.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    return;
  }
  const list = getFocusableElements(targetScope);
  if (list.length > 0) {
    list[0].focus({ preventScroll: true });
    list[0].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

type Direction = "up" | "down" | "left" | "right";

function findBestNeighbor(
  current: HTMLElement,
  candidates: HTMLElement[],
  dir: Direction
): HTMLElement | null {
  const cRect = current.getBoundingClientRect();
  const cx = cRect.left + cRect.width / 2;
  const cy = cRect.top + cRect.height / 2;
  const currentRow = current.closest("[data-tv-row]");

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;

    const dx = ex - cx;
    const dy = ey - cy;

    let primary = 0;
    let ortho = 0;

    if (dir === "left") {
      if (dx >= -4) continue;
      primary = -dx;
      ortho = Math.abs(dy);
    } else if (dir === "right") {
      if (dx <= 4) continue;
      primary = dx;
      ortho = Math.abs(dy);
    } else if (dir === "up") {
      if (dy >= -4) continue;
      primary = -dy;
      ortho = Math.abs(dx);
    } else if (dir === "down") {
      if (dy <= 4) continue;
      primary = dy;
      ortho = Math.abs(dx);
    }

    let score = primary + ortho * 2.6;

    // Strongly prefer staying in the same horizontal row on Left/Right
    if ((dir === "left" || dir === "right") && currentRow) {
      if (el.closest("[data-tv-row]") !== currentRow) {
        score += 10000;
      }
    }

    // Prefer moving out of the current horizontal row on Up/Down
    if ((dir === "up" || dir === "down") && currentRow) {
      if (el.closest("[data-tv-row]") === currentRow && ortho > cRect.height * 0.5) {
        score += 500;
      }
    }

    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

/**
 * Global TV D-Pad Spatial Navigation & Remote Back Handler.
 * Maps Arrow keys, Enter/OK, and TV Back keys (Escape / Backspace / Tizen 10009 / XF86Back).
 */
export function useTvNavigation(disabled: boolean = false) {
  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if custom player or component already handled the key
      if (e.defaultPrevented) return;

      const active = document.activeElement as HTMLElement | null;
      const inInput = isTextInput(active);

      // TV Remote Back / Return keys (Escape, Backspace outside input, Tizen 10009, XF86Back)
      const isBackKey =
        e.key === "Escape" ||
        e.key === "XF86Back" ||
        e.key === "GoBack" ||
        e.keyCode === 10009 ||
        e.keyCode === 461 ||
        (e.key === "Backspace" && !inInput);

      if (isBackKey) {
        e.preventDefault();
        playBackSound();
        window.dispatchEvent(new CustomEvent(TV_BACK_EVENT));
        return;
      }

      // Allow typing & caret movement inside text inputs unless pressing Up/Down to leave input
      if (inInput && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        return;
      }

      let dir: Direction | null = null;
      if (e.key === "ArrowUp") dir = "up";
      else if (e.key === "ArrowDown") dir = "down";
      else if (e.key === "ArrowLeft") dir = "left";
      else if (e.key === "ArrowRight") dir = "right";

      if (dir) {
        const scope = getActiveScope();
        const candidates = getFocusableElements(scope);
        if (candidates.length === 0) return;

        e.preventDefault();

        const currentInScope =
          active &&
          active.hasAttribute("data-tv-focusable") &&
          (scope === document || (scope as Element).contains(active)) &&
          isVisible(active);

        if (!currentInScope) {
          focusFirstInScope(scope);
          playHoverSound();
          return;
        }

        const next = findBestNeighbor(active, candidates, dir);
        if (next) {
          next.focus({ preventScroll: true });
          next.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
          playHoverSound();
        }
        return;
      }

      // OK / Enter activation for non-button focusable cards/items
      if ((e.key === "Enter" || e.key === "NumpadEnter") && !inInput) {
        if (active && active.hasAttribute("data-tv-focusable")) {
          const tag = active.tagName.toLowerCase();
          if (tag !== "button" && tag !== "a") {
            e.preventDefault();
            playButtonClickSound();
            active.click();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled]);
}

/**
 * Subscribe to the TV remote Back button when a modal/drawer is open.
 */
export function useTvBack(enabled: boolean, onBack: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: Event) => {
      e.stopImmediatePropagation();
      onBack();
    };
    window.addEventListener(TV_BACK_EVENT, handler);
    return () => window.removeEventListener(TV_BACK_EVENT, handler);
  }, [enabled, onBack]);
}
