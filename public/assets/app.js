(() => {
  document.addEventListener("click", async (event) => {
    const source = event.target;
    if (!(source instanceof Element)) return;

    const button = source.closest("[data-copy-target]");
    if (!(button instanceof HTMLButtonElement)) return;

    const targetId = button.dataset.copyTarget;
    const target = targetId ? document.getElementById(targetId) : null;
    const value = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
      ? target.value
      : target?.textContent ?? "";

    try {
      await navigator.clipboard.writeText(value);
      const originalText = button.textContent ?? "Copy";
      button.textContent = "Copied";
      button.classList.add("btn-success");
      window.setTimeout(() => {
        button.textContent = originalText;
        button.classList.remove("btn-success");
      }, 1600);
    } catch {
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        target.focus();
        target.select();
      }
    }
  });
})();
