import { useEffect } from "react";
import { playHoverSound, playButtonClickSound, playBackSound } from "../services/sound";

export const TV_BACK_EVENT = "rdx-tv-back";

/** LIFO stack of TV Back handlers so the top-most modal/drawer always closes first */
const tvBackStack: Array<() => void> = [];

function dispatchTvBack() {
  if (tvBackStack.length > 0) {
    const top = tvBackStack[tvBackStack.length - 1];
    top();
    return;
  }
  window.dispatchEvent(new CustomEvent(TV_BACK_EVENT));
}

// Bridge external hardware Back dispatches (e.g. Android MainActivity OnBackPressedCallback)
if (typeof window !== "undefined") {
  window.addEventListener(TV_BACK_EVENT, (e: Event) => {
    if (tvBackStack.length > 0) {
      e.stopImmediatePropagation();
      const top = tvBackStack[tvBackStack.length - 1];
      top();
    }
  });
}

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
  return rect.width > 0 && rect.height > 0;
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

interface FocusCandidate {
  el: HTMLElement;
  rect: DOMRect;
}

const getFocusableCandidates = (scope: ParentNode): FocusCandidate[] => {
  const out: FocusCandidate[] = [];
  const nodes = scope.querySelectorAll<HTMLElement>("[data-tv-focusable]");
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      out.push({ el, rect });
    }
  }
  return out;
};

export function focusFirstInScope(scope?: ParentNode) {
  const targetScope = scope || getActiveScope();
  const auto = targetScope.querySelector<HTMLElement>("[data-tv-autofocus]");
  if (auto && isVisible(auto)) {
    auto.focus({ preventScroll: true });
    auto.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
    return;
  }
  const list = getFocusableCandidates(targetScope);
  if (list.length > 0) {
    list[0].el.focus({ preventScroll: true });
    list[0].el.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
  }
}

type Direction = "up" | "down" | "left" | "right";

function findBestNeighbor(
  current: HTMLElement,
  candidates: FocusCandidate[],
  dir: Direction
): HTMLElement | null {
  const cRect = current.getBoundingClientRect();
  const cx = cRect.left + cRect.width / 2;
  const cy = cRect.top + cRect.height / 2;
  const currentRow = current.closest("[data-tv-row]");
  const currentInHeader = Boolean(current.closest("header"));

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const { el, rect: r } of candidates) {
    if (el === current) continue;
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

    // Never jump into fixed/sticky <header> while pressing Up if any content exists above
    if (dir === "up" && !currentInHeader && el.closest("header")) {
      score += 50000;
    }

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
        dispatchTvBack();
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
        const candidates = getFocusableCandidates(scope);
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
          const scrollBehavior: ScrollBehavior = e.repeat ? "auto" : "smooth";
          // When focus returns to Hero actions or fixed TopBar, scroll the actual <main> container (and window) to top
          if (next.closest('[data-tv-row="hero-actions"]') || next.closest("header")) {
            const mainEl = document.querySelector("main");
            if (mainEl) {
              mainEl.scrollTo({ top: 0, behavior: scrollBehavior });
            }
            window.scrollTo({ top: 0, behavior: scrollBehavior });
          } else {
            next.scrollIntoView({
              behavior: scrollBehavior,
              block: "nearest",
              inline: "center",
            });
          }
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
 * Subscribe to the TV remote Back button when a modal/drawer is open (LIFO stack order).
 */
export function useTvBack(enabled: boolean, onBack: () => void) {
  useEffect(() => {
    if (!enabled) return;
    tvBackStack.push(onBack);
    return () => {
      const idx = tvBackStack.lastIndexOf(onBack);
      if (idx >= 0) tvBackStack.splice(idx, 1);
    };
  }, [enabled, onBack]);
}
