/** Minimal user-visible error/message toast (spec §54: no silent failures). */
export class Toast {
    private static container: HTMLElement | null = null;

    private static ensureContainer(): HTMLElement {
        if (!Toast.container) {
            Toast.container = document.createElement("div");
            Toast.container.style.cssText =
                "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);" +
                "display:flex;flex-direction:column;gap:8px;z-index:300;pointer-events:none;align-items:center;";
            document.body.appendChild(Toast.container);
        }
        return Toast.container;
    }

    public static show(message: string, kind: "info" | "error" | "success" = "info", durationMs = 4000) {
        const container = Toast.ensureContainer();
        const el = document.createElement("div");
        const bg =
            kind === "error" ? "rgba(244,67,54,0.95)" :
            kind === "success" ? "rgba(76,175,80,0.95)" :
            "rgba(28,36,47,0.95)";
        el.style.cssText =
            `background:${bg};color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;` +
            "box-shadow:0 8px 30px rgba(0,0,0,0.5);max-width:70vw;";
        el.innerText = message;
        container.appendChild(el);
        window.setTimeout(() => {
            el.style.transition = "opacity 0.3s";
            el.style.opacity = "0";
            window.setTimeout(() => el.remove(), 300);
        }, durationMs);
    }
}