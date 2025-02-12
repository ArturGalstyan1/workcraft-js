// src/index.ts
var TokenExpiration = 24 * 60 * 60;
var createDefaultTaskPayload = (partial = {}) => ({
  task_args: partial.task_args ?? [],
  task_kwargs: partial.task_kwargs ?? {},
  prerun_handler_args: partial.prerun_handler_args ?? [],
  prerun_handler_kwargs: partial.prerun_handler_kwargs ?? {},
  postrun_handler_args: partial.postrun_handler_args ?? [],
  postrun_handler_kwargs: partial.postrun_handler_kwargs ?? {},
});
var TaskStatus = /* @__PURE__ */ ((TaskStatus2) => {
  TaskStatus2["PENDING"] = "PENDING";
  TaskStatus2["RUNNING"] = "RUNNING";
  TaskStatus2["SUCCESS"] = "SUCCESS";
  TaskStatus2["FAILURE"] = "FAILURE";
  TaskStatus2["INVALID"] = "INVALID";
  TaskStatus2["CANCELLED"] = "CANCELLED";
  return TaskStatus2;
})(TaskStatus || {});
var PeonStatus = /* @__PURE__ */ ((PeonStatus2) => {
  PeonStatus2["IDLE"] = "IDLE";
  PeonStatus2["PREPARING"] = "PREPARING";
  PeonStatus2["WORKING"] = "WORKING";
  PeonStatus2["OFFLINE"] = "OFFLINE";
  return PeonStatus2;
})(PeonStatus || {});
var UpdateType = /* @__PURE__ */ ((UpdateType2) => {
  UpdateType2["TASK_UPDATE"] = "task_update";
  UpdateType2["PEON_UPDATE"] = "peon_update";
  return UpdateType2;
})(UpdateType || {});
var WorkcraftClient = class {
  config;
  strongholdUrl;
  hashedApiKey = null;
  fetchWithApiKey = async (input, init) => {
    if (this.hashedApiKey === null)
      throw new Error("API key is not hashed yet.");
    return fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        WORKCRAFT_API_KEY: this.hashedApiKey,
      },
    });
  };
  sse = null;
  subscribers = /* @__PURE__ */ new Map();
  reconnectDelay = 5e3;
  // Start with 1 second
  constructor(config) {
    this.config = config;
    this.strongholdUrl = config.host + ":" + config.port;
  }
  async createJWT() {
    const now = Math.floor(Date.now() / 1e3);
    const secret = new TextEncoder().encode(this.config.apiKey);
    const jwt = await new SignJWT({ api_key: this.config.apiKey })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + TokenExpiration)
      .setNotBefore(now)
      .sign(secret);
    return jwt;
  }
  async setupSSE() {
    if (this.apiKey === null) {
      throw new Error("Client must be initialized before subscribing");
    }
    const url = `${this.strongholdUrl}/events?type=chieftain`;
    try {
      this.sse = new EventSource(url, { withCredentials: true });
    } catch (error) {
      console.error("Failed to create EventSource:", error);
      return;
    }
    this.sse.onopen = (event) => {
      console.log("SSE connection established");
    };
    this.sse.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);
        this.notifySubscribers(update);
      } catch (error) {
        console.error("Failed to parse SSE message:", error);
      }
    };
    this.sse.onerror = (error) => {
      console.error("SSE error:", error);
    };
  }
  notifySubscribers(update) {
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(update);
      } catch (error) {
        console.error("Error in subscriber:", error);
      }
    });
  }
  async subscribe(callback) {
    if (!this.sse) {
      await this.setupSSE();
    }
    function uuidv4() {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
        /[xy]/g,
        function (c) {
          var r = (Math.random() * 16) | 0,
            v = c == "x" ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        },
      );
    }
    const id = uuidv4();
    this.subscribers.set(id, callback);
    return () => {
      this.subscribers.delete(id);
      if (this.subscribers.size === 0 && this.sse) {
        this.sse.close();
        this.sse = null;
      }
    };
  }
  async disconnect() {
    if (this.sse) {
      this.sse.close();
      this.sse = null;
      this.subscribers.clear();
    }
  }
  async init() {
    this.apiKey = this.config.apiKey;
    try {
      console.log("fetching", this.strongholdUrl + "/api/test");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5e3);
      const res = await this.fetchWithApiKey(this.strongholdUrl + "/api/test", {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status !== 200) {
        console.error(`Server responded with status ${res.status}`);
      } else {
        console.log("Stronghold server is online");
      }
    } catch (error) {
      if (error instanceof Error) {
        if ("name" in error && error.name === "AbortError") {
          console.error("Connection timeout - server might be offline");
        } else {
          console.error(
            "Failed to connect to the stronghold server:",
            error.message,
          );
        }
      } else {
        console.error("Failed to connect to the stronghold server:", error);
      }
    }
  }
  async createTaskOrThrow({
    taskName,
    taskPayload = {},
    queue = "DEFAULT",
    retryOnFailure = false,
    retryLimit = 0,
  }) {
    const res = await this.fetchWithApiKey(this.strongholdUrl + "/api/task", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: uuidv4(),
        task_name: taskName,
        queue,
        retry_on_failure: retryOnFailure,
        retry_limit: retryLimit,
        payload: createDefaultTaskPayload(taskPayload),
      }),
    });
    if (res.status !== 201) {
      throw new Error("Failed to create a task: " + (await res.text()));
    }
    return res.json();
  }
  async getTaskByIdOrThrow(id) {
    const res = await this.fetchWithApiKey(
      this.strongholdUrl + "/api/task/" + id,
    );
    if (res.status !== 200) {
      throw new Error("Failed to get task by id: " + (await res.text()));
    }
    return res.json();
  }
  async getPeonByIdOrThrow(id) {
    const res = await this.fetchWithApiKey(
      this.strongholdUrl + "/api/peon/" + id,
    );
    if (res.status !== 200) {
      throw new Error("Failed to get peon by id: " + (await res.text()));
    }
    return res.json();
  }
  async cancelTaskOrThrow(id) {
    const res = await this.fetchWithApiKey(
      this.strongholdUrl + "/api/task/" + id + "/cancel",
      {
        method: "POST",
      },
    );
    if (res.status !== 200) {
      throw new Error("Failed to cancel task: " + (await res.text()));
    }
  }
};
export { PeonStatus, TaskStatus, UpdateType, WorkcraftClient };
//# sourceMappingURL=index.js.map
