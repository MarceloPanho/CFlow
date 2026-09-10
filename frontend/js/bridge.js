const Bridge = (() => {
  const ready = new Promise((resolve) => {
    if (window.pywebview && window.pywebview.api) {
      resolve(window.pywebview.api);
      return;
    }
    window.addEventListener("pywebviewready", () => resolve(window.pywebview.api), { once: true });
  });

  async function api() {
    return ready;
  }

  return {
    api,
    listSamples: async () => (await api()).list_samples(),
    readSample: async (name) => (await api()).read_sample(name),
    toolchain: async () => (await api()).toolchain_status(),
    analyze: async (source, cap, stepInto, watchAs) =>
      (await api()).analyze(source, cap, stepInto, watchAs),
  };
})();
