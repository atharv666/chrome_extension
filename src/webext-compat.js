const storage = globalThis.chrome?.storage;

function wrapStorageMethod(area, method) {
  if (!area || typeof area[method] !== "function") return;

  const original = area[method].bind(area);

  area[method] = (...args) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      return original(...args);
    }

    try {
      const maybePromise = original(...args);
      if (maybePromise && typeof maybePromise.then === "function") {
        return maybePromise;
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      original(...args, (result) => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "Extension storage error"));
          return;
        }

        resolve(result);
      });
    });
  };
}

if (storage) {
  [storage.local, storage.sync, storage.managed, storage.session]
    .filter(Boolean)
    .forEach((area) => {
      wrapStorageMethod(area, "get");
      wrapStorageMethod(area, "set");
      wrapStorageMethod(area, "remove");
      wrapStorageMethod(area, "clear");
    });
}
