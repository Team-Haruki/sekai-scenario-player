import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Scroll `el` to the middle of the scroll area around it, without moving the page. */
export function centerInScrollArea(el: Element | null | undefined, behavior: ScrollBehavior = "smooth") {
  const viewport = el?.closest<HTMLElement>("[data-reka-scroll-area-viewport]");
  if (!el || !viewport) return;
  const top = el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  viewport.scrollTo({ top: top - (viewport.clientHeight - el.getBoundingClientRect().height) / 2, behavior });
}
