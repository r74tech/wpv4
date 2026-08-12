export { escapeAttribute as escapeAttr, escapeHtml } from "../lib/html";

export function $(selector: string): HTMLElement | null {
	return document.querySelector(selector);
}

export function setHtml(el: HTMLElement | null, html: string) {
	if (el) el.innerHTML = html;
}
