export function $(selector: string): HTMLElement | null {
	return document.querySelector(selector);
}

export function setHtml(el: HTMLElement | null, html: string) {
	if (el) el.innerHTML = html;
}

export function escapeAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function escapeHtml(str: string): string {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}
