/**
 * Open the browser's file chooser and hand back what was picked.
 *
 * WHY THIS ISN'T `document.createElement("input").click()`. That detached
 * input is what every web picker here used to do, and it works on desktop.
 * On iPhone Safari it doesn't: the chooser opens, the person picks a photo,
 * and the `change` event never reaches the input, because nothing in the
 * document holds it. Dev2, 2026-11-05, "Code this charge" on
 * publicworship.life: "just tried to upload a receipt and nothing happened."
 *
 * So the input is attached to the document (invisible, off-screen, not
 * `display: none`, which some WebKit builds refuse to open) for as long as the
 * chooser is up, and removed once it answers. It must still be called
 * synchronously from the tap: Safari only opens a chooser inside the user
 * gesture, so never `await` anything before calling this.
 *
 * Resolves `[]` when the person cancels, where the browser reports it
 * (`cancel` event, Safari 16.4+/Chrome 113+). Older browsers never answer a
 * cancel, so callers must not hold a busy state across the pick.
 */
export function openWebFilePicker(options: {
  accept: string;
  multiple?: boolean;
}): Promise<File[]> {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || !document.body) {
      resolve([]);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.multiple = options.multiple === true;
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    Object.assign(input.style, {
      position: "fixed",
      top: "0",
      left: "-1000px",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
    });

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));

    document.body.appendChild(input);
    input.click();
  });
}
